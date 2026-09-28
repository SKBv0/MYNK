# Security

## Reporting a problem

Open an issue with the MYNK version and the steps that reproduce the problem. Remove your API key
and personal file paths from any logs or screenshots you attach.

Only the latest release gets fixes.

## Two things to know

- For previews, and for pages a plain download cannot read during analysis, MYNK opens the page in
  a headless Chrome or Edge. The page's scripts run there, in a throwaway profile that is deleted
  afterwards. A bug in the browser engine still applies, so keep Chrome or Edge up to date.
- Links an agent adds through the `mynk-mcp` inbox are analyzed automatically. That can include
  opening them in the headless browser.
