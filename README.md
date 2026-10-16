# PC Remote

Control your Windows PC from your phone (or any browser) over an encrypted
connection, upload/download files, and reach your phone's storage from Windows
Explorer.

- **Phone app?** No app store needed. It is a web app; open the address in
  Chrome on Android and use "Add to Home screen" to get an icon.
- **Security:** HTTPS everywhere, username + password login (bcrypt-hashed),
  signed session cookies, login rate limiting, and Basic auth on the WebDAV
  share.
- **Control:** trackpad with gestures, on-screen keyboard, shortcut keys, and an
  optional live screen view you can also click/drag on.
- **Files:** upload files or whole folders from the phone into a folder on the
  PC; browse, download, rename and delete from the phone.
- **Explorer access:** that folder is also published over WebDAV, so it can be
  mapped as a network drive (`Z:\`) in Windows Explorer.
- **From anywhere:** built-in [Tailscale](https://tailscale.com) support — install
  it on the PC and the phone, sign in to the same account, and the app works on
  mobile data anywhere. See **Settings → Use it from anywhere**.

---

## 1. Start it

1. Double-click **`start.bat`**.
   The first run installs dependencies and prints your login details:

   ```
   FIRST RUN - save these credentials now:
     username: <your windows user>
     password: <random password>
   ```

   The same details are written to `data\INITIAL-PASSWORD.txt` — sign in, change
   the password in the **Settings** tab, then delete that file.

2. The console shows the address to use from the phone, e.g.

   ```
   Phone / tablet address : https://192.168.1.38:8443
   ```

   A QR code is printed too: scan it with the phone camera to open the address.

3. On the phone, the browser will warn about the certificate (it is
   self-signed). Choose **Advanced → Proceed**. You only need to do this once
   per browser.

4. Windows will ask whether to allow Node.js through the firewall the first
   time — click **Allow**. Or run **`allow-firewall.bat`** as administrator to
   add the rules silently.

> **If the page does not load:** use the address exactly as printed, including
> the `https://` scheme. If the scheme is missing the browser tries `http://`
> first — the app now answers that with a redirect to `https://`, but you will
> still have to accept the certificate warning once. Typing the address with
> the wrong port (or pasting a `net use` command into the address bar) shows a
> "Not found" page: that is the file share, not the app.

## 2. Use it

| Tab | What it does |
| --- | --- |
| **Control** | The live screen at the top with the trackpad and the click buttons directly underneath, so you can always see what you are doing (the mouse pointer is drawn into the picture). The pad only moves the pointer (1 finger) and scrolls (2 fingers); the big **Left / Right / Middle** buttons sit on its right — tap to click, or press and hold one while moving the pad to drag. **Remote control** lets you drag/click straight on the screen picture, and ⛶ is fullscreen. Pinch the picture (or double-tap it, or use 🔍 −/＋/Fit) to zoom in and pan around when the phone screen makes it too small. Under the pad: the on-screen keyboard, Esc/Tab/Del/Enter/arrows, and a *Keys & shortcuts* drawer with the Ctrl/Alt/Shift/Win toggles and shortcuts (Ctrl+C/V/A/Z, Alt+Tab, Win+D/E). |
| **Files** | **Upload files** / **Upload folder** push content from the phone into the current folder on the PC, with a progress bar per file. Tap a file to open/download it, ✎ to rename, 🗑 to delete. **Open on PC** opens that folder in Explorer on the PC itself. |
| **Settings** | Change password, **sign out**, tune pointer/scroll speed, set the live-screen FPS/quality, **Test input** if the PC ignores your clicks, see the QR/addresses, and get the WebDAV mapping instructions. |

Battery note: tap **Start live screen** to begin streaming (the app remembers
that choice). The stream stops by itself when you leave the Control tab, lock the
phone, or press **Stop**, and comes back when you return. The capture process on
the PC also stops itself a few seconds after the last viewer disconnects.

## 3. Phone storage in Windows Explorer

Everything the phone uploads lands in:

```
<this folder>\data\phone-storage
```

Because it is a normal folder, you can just open it in Explorer. To have it as a
mapped network drive (available to any app, and from other PCs), use the WebDAV
share that the app also serves:

1. **One time:** run **`trust-certificate.bat`** as administrator on the PCs
   that will map the drive.
2. **One time, for files over 50 MB:** double-click
   **`enable-webdav-largefiles.reg`** and accept, then restart the *WebClient*
   service (`services.msc`) or reboot.
3. In Explorer: **This PC → Map network drive**, and enter

   ```
   https://<pc-name>:8243/phone
   ```

   Tick *Connect using different credentials* and use the same username/password
   as the web app.

   Or from a command prompt:

   ```
   net use Z: https://<pc-name>:8243/phone /user:<username> *
   ```

The address is also shown in the app's **Settings** tab, with copy buttons for
the address and for the `net use` command.

> **Put the address in Explorer, not in a web browser.** The WebDAV port (8243)
> is a file share, not a web page: opening it in a browser — or pasting the
> `net use` command into the address bar — gives a "Not found" page (in recent
> versions it shows a short help page instead). The `net use` command belongs in
> a **Command Prompt**.

> Windows' built-in WebDAV client is fine for documents, photos and media. For
> very large or heavily-used shares, a real SMB/SFTP server is faster — the local
> folder above is the simplest alternative and always works.

## 4. Using it from outside your home

The server listens on all interfaces, so you have two options.

### Recommended — Tailscale (built in, nothing exposed)

[Tailscale](https://tailscale.com) is a free private network (like a "virtual
Wi-Fi" between *your* devices). It works on Android too, so the phone can reach
the PC from any mobile network — no router changes and nothing is exposed to the
public internet.

1. Install Tailscale on the **phone** and sign in.
2. Install Tailscale on the **PC** and sign in to the **same** account.
3. Open the app's **Settings → Use it from anywhere** card and tap
   **Recheck**. It then shows the address to use, e.g.
   `https://<pc-tailscale-name>:8443`, with a QR code to scan from the phone.

Once Tailscale is running the app is reachable from any device on your tailnet.
The status card tells you what to do at each step (not installed / not connected
/ ready).

**Get a trusted certificate (optional, removes the browser warning).**
By default the app uses its own self-signed certificate, so the browser shows a
warning. In the Tailscale admin console enable **MagicDNS** and **HTTPS
certificates**, then click **Get trusted certificate** in the same card and
restart the app. It downloads a real Let's Encrypt certificate for the
`…ts.net` name.

### Alternative — router port forwarding (exposes the port to the internet)

Forward an external TCP port to this PC's port 8443 (and 8243 if you want WebDAV
outside the LAN). Then browse to `https://<your-public-ip-or-ddns>:<port>`. Use a
strong password, keep the app updated, and expect the certificate warning (the
certificate is issued for your LAN name/IP). If your ISP uses CGNAT, port
forwarding will not work — use Tailscale above.

## 5. Security notes

- Anyone who can sign in can control the PC completely. Use a long password.
- Sessions are signed HTTP-only cookies with `Secure` + `SameSite=Strict`; they
  expire after 14 days (change `sessionHours` in `data\config.json`).
- Six wrong passwords in a row lock the source IP out for 10 minutes.
- WebDAV requires the same credentials; delete `data\INITIAL-PASSWORD.txt` after
  you change the password.
- Hidden data lives in `data\`: `config.json` (username, bcrypt hash, token
  secret), `cert\` (TLS key + certificate; a Tailscale-issued pair is stored as
  `tailscale.pem` / `tailscale-key.pem` and used in preference), `phone-storage\`
  (files), `tmp\` (uploads in progress), `bin\` (compiled helper).
- If you enable Tailscale *after* the app has already created its certificate, the
  browser may warn about a name mismatch (the certificate was made before the
  tailnet address existed). Fix it with **Get trusted certificate** in the
  Tailscale card, or delete `data\cert\cert.pem` and `data\cert\key.pem` and
  restart so a fresh certificate is generated.
- Some antivirus products flag programs that send mouse/keyboard input or capture
  the screen (`data\bin\RemoteHelper.exe`). It is built locally from
  `lib\native\RemoteHelper.cs` — read it, then allow it if your AV complains.
- Ctrl+Alt+Del and Win+L cannot be sent by any remote-control tool (Windows
  requires a physical secure attention sequence).
- The mouse pointer is drawn into the live-screen frames (Windows' screen
  capture does not include it), so you can see where the pointer is. On a busy or
  dark window it can be small — pinch the picture (or use 🔍 −/＋/Fit) to zoom in.
- If the phone shows the screen but moving the pointer or clicking does nothing,
  open **Settings → Remote control → Test input**. The PC ignores synthetic
  input while the session is locked and when an elevated ("Run as
  administrator") window has focus; run **`start.bat` as administrator** if that
  happens. The app also shows a banner when it detects that Windows is dropping
  the input, and logs `input blocked …` in the console window.

## 6. Command-line extras

```
node server.js --set-password "new password"    # reset a forgotten password
node test/smoke.js                              # self-test while the server runs
node test/transport.js                          # http->https redirect + WebDAV pages
node test/e2e-browser.js                        # drives the real UI against the server
node test/css-render.js                         # real-browser check (Edge/Chrome)
node test/layout-control.js                     # Control-tab layout check (Edge/Chrome)
node test/ui-dom.js                             # frontend wiring, no server needed
node test/ui-check.js                           # verify UI wiring statically
node test/tailscale.js                          # Tailscale detection/parsing (no Tailscale needed)
```

The tests sign in with `data\INITIAL-PASSWORD.txt` if it is still there. After
you change the password and delete that file, pass the password
(`PC_REMOTE_PASSWORD="…"`) or a session cookie (`PC_REMOTE_COOKIE="pcrc_session=…"`)
instead; the WebDAV content checks are skipped when the password is not
available. `test/css-render.js` and `test/layout-control.js` use headless
Edge/Chrome and skip if neither is installed.

Change ports, screen capture defaults (fps/quality/max width) in
`data\config.json`, then restart.

## 7. Start automatically with Windows

1. Press `Win+R`, run `shell:startup`.
2. Put a shortcut to `start.bat` in that folder (or use Task Scheduler with
   *At log on* if you want it to run hidden).
