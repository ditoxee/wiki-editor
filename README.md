# Wiki Editor (Local App)

This is a standalone local app for editing `wikiData.ts` files.
It is not connected to site routes and does not appear in the main website UI.

## Run

```bash
npm install
npm run dev
```

Open:

- `http://localhost:5174`

## Build

```bash
npm run build
```

## Notes

- The editor opens a local file through the system file picker.
- Save writes directly to the selected file (or via Save As).
- Autosave is enabled by default and saves after short pause while editing.
- If no file is selected yet, autosave stores a local draft in browser storage.
- If direct file writing is not supported by the browser, the editor downloads the file.
