#!/usr/bin/env bash
# Install / remove the FastCU bridge for ATLYSS (Proton). Steam and the game must be closed.
#   install.sh install     copy BepInEx 5 + plugin into the game folder, add winhttp DLL override
#   install.sh uninstall   remove every file this script added and the override
# Saves are never touched. Backups: ~/atlyss-harness-work/backup/
set -euo pipefail
G="$HOME/.local/share/Steam/steamapps/common/ATLYSS"
REG="$HOME/.local/share/Steam/steamapps/compatdata/2768430/pfx/user.reg"
W="$HOME/atlyss-harness-work"
ADDED=(BepInEx winhttp.dll doorstop_config.ini .doorstop_version changelog.txt)
# exact process names only: `pgrep -f` matches the shell running this script
if pgrep -x steam >/dev/null || pgrep -x ATLYSS.exe >/dev/null; then echo "close Steam and the game first"; exit 1; fi
case "${1:-}" in
  install)
    for f in "${ADDED[@]}"; do [ -e "$G/$f" ] && [ ! -e "$W/installed.marker" ] && { echo "refusing: $G/$f exists and was not installed by this script"; exit 1; }; done
    cp -r "$W/bepinex/." "$G/"
    mkdir -p "$G/BepInEx/plugins"
    cp "$W/build/FastCUBridge.dll" "$G/BepInEx/plugins/"
    cp -n "$REG" "$W/backup/user.reg.pre-install"
    python3 - "$REG" <<'PY'
import sys,re
p=sys.argv[1]; s=open(p,encoding='utf-8',errors='surrogateescape').read()
hdr='[Software\\\\Wine\\\\DllOverrides]'
line='"winhttp"="native,builtin"'
if line in s.split(hdr,1)[-1].split('\n[',1)[0] and hdr in s:
    print('override already present')
elif hdr in s:
    i=s.index(hdr); j=s.index('\n',i)
    k=s.find('\n\n',j)                      # end of that section
    s=s[:k]+'\n'+line+s[k:]; open(p,'w',encoding='utf-8',errors='surrogateescape').write(s); print('override added to existing section')
else:
    s=s.rstrip('\n')+'\n\n'+hdr+' 1790000000\n#time=1dc0000000000000\n'+line+'\n'; open(p,'w',encoding='utf-8',errors='surrogateescape').write(s); print('override section created')
PY
    date -Is > "$W/installed.marker"; echo installed ;;
  uninstall)
    for f in "${ADDED[@]}"; do rm -rf "${G:?}/$f"; done
    python3 - "$REG" <<'PY'
import sys
p=sys.argv[1]; s=open(p,encoding='utf-8',errors='surrogateescape').read()
n=s.replace('\n"winhttp"="native,builtin"','')
open(p,'w',encoding='utf-8',errors='surrogateescape').write(n); print('override removed' if n!=s else 'no override found')
PY
    rm -f "$W/installed.marker"; echo uninstalled ;;
  *) echo "usage: install.sh install|uninstall"; exit 2 ;;
esac
