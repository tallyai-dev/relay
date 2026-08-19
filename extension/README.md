# Add to Relay — Chrome extension

One-click "add this salon to Relay" while you're browsing (a salon's website, a Google listing, a directory).

## Install (takes 30 seconds)

1. Open Chrome → go to `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this `extension` folder
5. Pin the **Add to Relay** icon to your toolbar (puzzle-piece menu → pin)

## Use

On any salon's page, click the **Add to Relay** icon. It reads the business
name, phone, and city off the page, prefills the form — edit anything, then
click **Add to Relay**. The salon shows up in Relay as a new lead (source =
"extension"), ready to work in a cadence.

## Notes

- Points at the live app: `https://tallyai-relay.netlify.app`. If the URL ever
  changes, update `RELAY_BASE` at the top of `popup.js` and the
  `host_permissions` entry in `manifest.json`.
- Chrome's own pages (`chrome://`, the web store) block page reading — on those
  you can still type the details in manually.
