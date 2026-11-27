# TheWavly MCP server

Lets any AI agent that speaks the Model Context Protocol check a purchase against what the user approved, before it pays. Works with Claude Desktop, Claude Code, Cursor and other MCP clients.

## Install from the SDK bundle

Download the Apache-2.0 SDK bundle into your application directory and extract it:

```bash
curl -fL https://thewavly.com/sdk/thewavly-open.tar.gz -o thewavly-open.tar.gz
tar -xzf thewavly-open.tar.gz
```

Node 20 or newer is required. The extracted MCP server has no dependencies and can run directly. In the configuration below, replace `/absolute/path/to` with the absolute path of the extracted `thewavly-open` directory.


```json
{
  "mcpServers": {
    "wavly": {
      "command": "npx",
      "args": ["-y", "@thewavly/mcp"],
      "env": { "WAVLY_API_KEY": "sk_test_…" }
    }
  }
}
```

Tools:

| Tool | What the agent does with it |
| --- | --- |
| `wavly_create_mandate` | Records what the user approved: items, most per purchase, an optional budget, UPI payees |
| `wavly_check_purchase` | Called right before paying. Returns PROCEED, ASK FIRST (with a link for the user) or STOP, in words the agent follows |
| `wavly_get_check` | Looks up a check, for example to see whether the user approved |
| `wavly_report_payment` | Records paid, failed or cancelled, so the budget stays correct |

**A registered agent.** If your agent is in TheWavly's [public registry](https://thewavly.com/agents), give the server its identity. Set `WAVLY_AGENT` to its handle and `WAVLY_AGENT_KEY_FILE` to its private key (a JWK file), or put the JWK itself in `WAVLY_AGENT_KEY`. Every check is then signed and counts toward the agent's public record.

On PROCEED, the agent is also told which headers to send a store that takes TheWavly: `Wavly-Agent` and `Wavly-Payment-Token`. Such a store verifies them before it charges; see [For merchants](https://thewavly.com/developers#merchants).

Amounts are in rupees for the agent's convenience. The server converts them to paise for the API. Set `WAVLY_BASE_URL` to point at another TheWavly deployment.

**Advisory or enforced.** This server gives the agent a check to call. An agent that has been talked into something can skip it. To make the check impossible to skip, put [TheWavly Guard](../guard) in front of the MCP server that places the order.
