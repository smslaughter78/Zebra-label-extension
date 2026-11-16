# Print Shipping Label (4x6) — Chrome extension

Finds the shipping label on a letter-size page or PDF, crops it, rotates it to
portrait, and prints it on a 4x6 thermal label printer (Zebra etc.).

## Install
1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → pick this folder.
3. Optional: in the extension's Details, turn on **Allow access to file URLs**
   so it works on labels opened from disk.

## Use
- Right-click the label page, a label image, or a link to a label PDF →
  **Print Shipping Label**. (Also: toolbar icon, or Alt+Shift+L.)
- An editor tab opens with the label detected. Adjust the crop box or rotation
  if needed, then **Print**.
- First time, in Chrome's print dialog: pick the Zebra, paper size 4x6,
  margins None, scale 100%. Chrome remembers the choice.
- If a page can't be read (one-time download links, some carrier sites),
  download the label and drop the file onto the editor tab.

## Notes
- Everything runs locally; nothing is uploaded.
- Printing goes through the normal printer driver, so the Zebra must be
  installed as a printer on the computer with a 4x6 stock defined.
- PDF rendering uses the bundled pdf.js (Apache-2.0, see `lib/PDFJS-LICENSE`).
