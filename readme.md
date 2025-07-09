# intro
*cC~* ⌨️😌

https://github.com/user-attachments/assets/247d7223-b6c5-4d95-b0fb-2f449d070554

- it turns your ChatGPT text into live Siri voice output in real time
- keep your hands free and your eyes rested

# setup

1. **Run the server**
   - Install [Bun](https://bun.sh) if you do not have it.
   - Start the local TTS server with:

     ```bash
     bun "bun serv.ts"
     ```

     The default server port is defined as `SERVER_PORT` in `bun serv.ts` (currently 80808). If you change it, make sure the userscript points to the same port.

2. **Install the userscript**
   - Install the Tampermonkey browser extension.
   - Create a new script and copy the contents of `monkey.js` into it.
   - The script sends ChatGPT replies to the running Bun server for speech.

3. **Optional Siri voice tuning**
   - Press `⌘`+Space to open macOS System Settings.
   - Search "spoken content" and choose your preferred Siri voice (for example Siri Voice 2).

Enjoy hands‑free responses!

---
Reference:

This project combines a userscript for chatgpt.com with a small Bun server on macOS using the built‑in voices.
It started as an experiment to speak tokens as they stream instead of clicking the "read aloud" button.
