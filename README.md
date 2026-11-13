# Focus planner (Telegram Mini App)

A static page that opens inside Telegram to plan tomorrow and fill in a daily benchmark.

- It holds no token, no name and no personal data, and makes no network request of its own.
- The plan travels in the part of the link after `#`, which browsers never send to this host.
- Changes go back only through Telegram (`Telegram.WebApp.sendData`).

Source of truth: `miniapp/` in the Focus app. This repo is a copy of `index.html` and `codec.js`.
