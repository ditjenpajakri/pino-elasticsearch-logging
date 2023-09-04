@ditjenpajakri/elasticsearch-logging

## Add to existing project

```
yarn global add @ditjenpajakri/elasticsearch-logging

# or npm install -g @ditjenpajakri/elasticsearch-logging
```

Setup the environment variables

```
LOG_ES_HOST                 Elasticsearch node. Default: http://localhost:9200
LOG_ES_USER                 Elasticsearch username
LOG_ES_PASS                 Elasticsearch password
LOG_ES_INDEX                Elasticsearch Index. Default: DJP-%{DATE}
LOG_ES_FLUSH_BYTES          Bytes size before flushing to Elasticsearch
LOG_ES_FLUSH_INTERVAL       Interval time before flushing to Elasticsearch (in ms). Default: 30000 miliseconds
LOG_ES_REJECT_UNAUTHORIZED  Reject Unauthorized for Self Signed Cert SSL. If not set to true, it will be set to false.
```

```
node server.js | log-to-es
```
