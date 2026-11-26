Wren/3270 — Windows Portable Build
======================================

No install step. Unzip this folder anywhere and double-click Wren3270.exe.
It opens your default browser to the terminal client automatically.

No admin rights are needed for normal use (3270/SSH/FTP/Telnet sessions,
macros).

Where your data lives
----------------------
ssh-hosts.txt, ftp-hosts.txt, telnet-hosts.txt, lpars.txt, scope.json,
macros/local/, and everything else you create live flat next to
Wren3270.exe. Delete the whole extracted folder to reset to a clean
state — there's no hidden state anywhere else on the machine.

Firewall and SmartScreen
--------------------------
Wren3270.exe binds to 127.0.0.1 only (not 0.0.0.0), so it shouldn't trigger
a Windows Firewall prompt — it's not listening on your network, only to
your own browser.

This build is unsigned. Expect a SmartScreen "unrecognized app" warning on
first run, and don't be surprised if an AV engine flags it — it bundles
SSH/FTP/Telnet clients, the same general shape as other remote-connection
tools. Verify the download against SHA256SUMS.txt before trusting it:

    certUtil -hashfile Wren3270.exe SHA256

...and compare the result to the Wren3270.exe line in SHA256SUMS.txt.

Support
-------
See the main project README and DOCUMENTATION/ for everything else — this
file only covers what's different about the Windows build.
