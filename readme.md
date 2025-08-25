- only work on macos.

# setup
i. installed Tempermonkey. ([get now](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo?hl=en))

ii. [install cC script](https://greasyfork.org/en/scripts/547214-cc/code)

iii. run this in ur terminal
```
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  exec $SHELL
fi
curl -fsSL "https://raw.githubusercontent.com/happyf-weallareeuropean/cC/main/bun%20serv.ts" | bun run -
```

 all set, Enjoy! 

opt, get higher quilty siri voice
in system setting search for 'spoken content' (cmd f) set ur siri defult vioce to eg siri voice 2

---
demo

https://github.com/user-attachments/assets/247d7223-b6c5-4d95-b0fb-2f449d070554

---

cridit Johannes Thyroff(https://github.com/JThyroff/WideGPT). 

---


the js script realtimely watch n extrect assistant tokens from chatgpt.com ,  then steaming send to lua processe the siri-tts part. like this  instead of wait whole chatgpt resp finish then scroll down to bomtom n navigate corsor to 'read aloud' button n click it got the chatgpt tts every time.

to use cC~ req download hammerspon n userscript extension like tampermonkey on they siswser.

cC~ is the short name of this proj, while the repo name made by theclearty to transport info.
