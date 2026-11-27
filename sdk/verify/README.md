# @thewavly/verify

Verifies a TheWavly evidence pack completely offline. There are no dependencies and no call to TheWavly.

```bash
npx @thewavly/verify wavly-evidence-chk_123.json
npx @thewavly/verify pack.json --jwks jwks.json      # use keys you fetched yourself
```

The exit code is 0 only when everything verifies. The format is described in [spec/wavly-formats-v1.md](../../spec/wavly-formats-v1.md).
