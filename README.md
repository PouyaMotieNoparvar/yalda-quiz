# Yalda Night Quiz 🍉❄🌙

A live, Mentimeter-style quiz for **Yalda Night**, hosted by the **University of Galway Iranian Society**.
It runs entirely on GitHub Pages, with no server to maintain.

| Who | Page |
|---|---|
| **Presenter** (your laptop on the projector) | `https://<your-user>.github.io/yalda-quiz/host.html` |
| **Guests** (phones; reached via the QR code) | `https://<your-user>.github.io/yalda-quiz/` |

## How the night runs

1. Open **host.html** on the laptop connected to the projector. Press **F** for fullscreen.
2. **Slide 1:** the welcome image. Press **→** (or click **Next**).
3. **Slide 2:** QR code and room code. Guests scan, type their name, and appear on screen.
4. Click **Start the quiz**. Each question runs for **30 s** on every phone.
5. When the timer ends, phones show *Correct / Not quite*, their points and their rank.
   Your screen shows the vote chart, with the correct answer highlighted, and the Top 5.
6. Press **→** for the next question. After the last one you get the **podium** (3rd → 2nd → 1st, with confetti).
   Press **→** again for the **full ranking and statistics**.
7. The results **CSV downloads automatically** when the final screen opens.
   There are also buttons to download the results CSV again and to download per-question statistics.

**Scoring:** a correct answer earns 500 to 1000 points; the faster the answer, the more points. A wrong answer or no answer earns 0.

### Keyboard / clicker
`→` `Space` `Enter` `PageDown` = next · `←` `PageUp` = back · `F` = fullscreen · `E` = end the timer early.
Presentation clickers send PageDown, so a clicker works too.

### If something goes wrong
- **Laptop refreshed or browser closed?** Open host.html again and click **Resume**. Players and scores are saved in the browser.
- **A guest refreshed their phone?** They are put back into the game automatically.
- **Guests can't connect?** ⚙ Settings → *Connection server* → pick another server (only before starting). The QR code updates automatically.
  The default server (shiftr.io) uses the normal HTTPS port 443, so it works on university Wi-Fi that blocks other ports.

## Editing the questions

Edit `MCQ.txt` (one blank line between questions; end the right option's line with `Correct`):

```
1- How many provinces does Iran currently have?
29
30
31 Correct
32
```

Then either:
- run `python tools/build_questions.py` and push. This rebuilds `js/questions.js`, where the answers are encoded so they can't be read at a glance. **Or**
- on the night, open ⚙ Settings → **Load MCQ.txt…** on the presenter laptop. The file stays on that laptop and is never uploaded.

`MCQ.txt` is in `.gitignore`, so the plain-text answers are never published.

## Run locally
```
python -m http.server 8765
```
Then open http://localhost:8765/host.html.
