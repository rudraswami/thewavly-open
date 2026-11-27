# Contributing

Thank you for helping. Three kinds of contribution help most.

## A bench scenario

Add it to `bench/scenarios.mjs` with:
- the user's words;
- the mandate those words become;
- four offers;
- the IDs of the acceptable offers.

Every condition must be something the user said. Then run the bench against the hosted API in test mode:

```bash
cd bench && WAVLY_API_KEY=sk_test_… node run.mjs --scripted
```

If TheWavly's answer disagrees with your acceptable list, the mandate usually doesn't say what the user said.

## An incident

Open an issue with a public link: a news report, a public bug, or a post by the person affected. Say what was asked, what happened, and what is still unknown. Leave out personal details that are not already public.

## SDKs, the MCP server and the verifier

Keep them free of dependencies. Run `node --test tests/*.test.mjs` and `python -m unittest discover -s sdk/python/tests` before opening a pull request.

By contributing, you agree that your contribution is licensed under Apache-2.0.
