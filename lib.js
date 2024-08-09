#! /usr/bin/env node
"use strict";

const { Client } = require("@elastic/elasticsearch");
const split = require("split2");
const pump = require("pump");
const fs = require("fs");
const { configDotenv } = require("dotenv");

/**
 * Performs a deep merge of objects and returns new object. Does not modify
 * objects (immutable) and merges arrays via concatenation.
 *
 * @param {...object} objects - Objects to merge
 * @returns {object} New object with merged key/values
 */
function mergeDeep(...objects) {
  const isObject = (obj) => obj && typeof obj === "object";

  return objects.reduce((prev, obj) => {
    Object.keys(obj).forEach((key) => {
      const pVal = prev[key];
      const oVal = obj[key];

      if (Array.isArray(pVal) && Array.isArray(oVal)) {
        prev[key] = pVal.concat(...oVal);
      } else if (isObject(pVal) && isObject(oVal)) {
        prev[key] = mergeDeep(pVal, oVal);
      } else {
        prev[key] = oVal;
      }
    });

    return prev;
  }, {});
}

function setDateTimeString(value) {
  if (typeof value === "object" && value.hasOwnProperty("time")) {
    if (
      (typeof value.time === "string" && value.time.length) ||
      (typeof value.time === "number" && value.time >= 0)
    ) {
      return new Date(value.time).toISOString();
    }
  }
  return new Date().toISOString();
}

function initializeBulkHandler(opts, client, splitter) {
  const esVersion = Number(opts.esVersion || opts["es-version"]) || 7;
  const index = opts.index || "pino";
  const buildIndexName = typeof index === "function" ? index : null;
//   const type = esVersion >= 7 ? undefined : opts.type || "log";
  const opType = esVersion >= 7 ? opts.opType || opts.op_type : undefined;

  // Resurrect connection pool on destroy
  splitter.destroy = () => {
    if (typeof client.connectionPool.resurrect === "function") {
      client.connectionPool.resurrect({ name: "elasticsearch-js" });
    }
  };

  const bulkInsert = client.helpers.bulk({
    datasource: splitter,
    flushBytes: opts.flushBytes || opts["flush-bytes"] || 1000,
    flushInterval: opts.flushInterval || opts["flush-interval"] || 30000,
    refreshOnCompletion: getIndexName(),
    onDocument(doc) {
      const date = doc.time || doc["@timestamp"];
      if (opType === "create") {
        doc["@timestamp"] = date;
      }

      return {
        create: {
          _index: getIndexName(date),
          // _type: type,
        },
      };
    },
    onDrop(doc) {
      const error = new Error("Dropped document");
      error.document = doc;
      splitter.emit("insertError", error);
    },
  });

  bulkInsert.then(
    (stats) => splitter.emit("insert", stats),
    (err) => splitter.emit("error", err)
  );

  function getIndexName(time = new Date().toISOString()) {
    if (buildIndexName) {
      return buildIndexName(time);
    }
    return index.replace(
      "%{DATE}",
      time.substring ? time.substring(0, 10) : ""
    );
  }
}

function pinoElasticSearch(opts = {}) {
  const splitter = split(
    function (line) {
      let value;
      try {
        value = JSON.parse(line);
      } catch (error) {
        console.log(line);
        // this.emit('unknown', line, error)
        return;
      }

      if (typeof value === "boolean") {
        this.emit("unknown", line, "Boolean value ignored");
        return;
      }
      if (value === null) {
        this.emit("unknown", line, "Null value ignored");
        return;
      }
      if (typeof value !== "object") {
        value = {
          data: value,
          ["@timestamp"]: setDateTimeString(value),
        };
      } else {
        value["message"] = value.msg || "-";

        if (value.msg) delete value.msg;

        value["@timestamp"] = setDateTimeString(value);

        if (value.time) delete value.time;
      }
      return mergeDeep(value, opts.additionalObject);
    },
    { autoDestroy: true }
  );

  const clientOpts = {
    node: opts.node,
    auth: opts.auth,
    // cloud: opts.cloud,
    tls: {
      rejectUnauthorized: false,
    },
  };

  if (opts.caFingerprint) {
    clientOpts.caFingerprint = opts.caFingerprint;
  }

  if (opts.Connection) {
    clientOpts.Connection = opts.Connection;
  }

  if (opts.ConnectionPool) {
    clientOpts.ConnectionPool = opts.ConnectionPool;
  }

  const client = new Client(clientOpts);
  console.log("Logging to elasticsearch...");
  console.log(
    "Any line showing up here means that the line was not logged to elasticsearch."
  );
  client.diagnostic.on("resurrect", () => {
    initializeBulkHandler(opts, client, splitter);
  });

  initializeBulkHandler(opts, client, splitter);

  return splitter;
}

function start(opts) {
  console.log("opts", opts);
  const stream = pinoElasticSearch(opts);

  stream.on("unknown", (line, error) => {
    console.error(
      "Elasticsearch client json error in line:\n" + line + "\nError:",
      error
    );
  });
  stream.on("error", (error) => {
    console.error("Elasticsearch client error:", error);
  });
  stream.on("insertError", (error) => {
    console.log(JSON.stringify(error));
    console.error("Elasticsearch server error:", error);
  });

  pump(process.stdin, stream);
}

module.exports = pinoElasticSearch;

if (require.main === module) {
  const fileEnv = process.argv[2];

  if (fileEnv && fs.statSync(fileEnv)) {
    configDotenv({
      path: fileEnv,
    });
  }

  const additionalFields = Object.keys(process.env).filter((key) =>
    key.startsWith("LOG_ES_VAR_")
  ).map(s => s.toLowerCase())

  const additionalObject = additionalFields.reduce((obj, field) => {
    const value = process.env[field.toLocaleUpperCase()];
    function processKey(f, value) {
      const parts = f ? f.split("_") : [];
      if (parts.length) {
        return processKey(parts.slice(0, parts.length - 1).join("_"), {
          [parts[parts.length - 1]]: value,
        });
      } else {
        if (f) return { [f]: value };
        else return value;
      }
    }

    return mergeDeep(obj, processKey(field, value));
  }, {});

  start({
    node: process.env.LOG_ES_HOST || "http://localhost:9200",
    additionalObject: additionalObject?.log?.es?.var ? additionalObject.log.es.var : {},
    auth: {
      username: process.env.LOG_ES_USER || "elastic",
      password: process.env.LOG_ES_PASS || "changeme",
    },
    index: process.env.LOG_ES_INDEX || "logs-apm-%{DATE}",
    flushBytes: process.env.LOG_ES_FLUSH_BYTES
      ? parseInt(process.env.LOG_ES_FLUSH_BYTES)
      : undefined,
    flushInterval: process.env.LOG_ES_FLUSH_INTERVAL
      ? parseInt(process.env.LOG_ES_FLUSH_INTERVAL)
      : undefined,
    rejectUnauthorized:
      process.env.LOG_ES_REJECT_UNAUTHORIZED === "true" ? true : false,
  });
}
