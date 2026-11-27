#!/bin/sh
# Installs VM Bridge (server, dashboard and CLI in one file) on macOS or Linux.
#   curl -fsSL https://raw.githubusercontent.com/vkpdeveloper/vmbridge/main/install.sh | sh
# VMBRIDGE_INSTALL_DIR picks where the file goes (default ~/.local/bin).
set -eu

repo="vkpdeveloper/vmbridge"
dir="${VMBRIDGE_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "VM Bridge runs on macOS and Linux only." >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

# Rosetta reports x86_64 on Apple silicon. Use the native build instead.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
  arch=arm64
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  sha256="shasum -a 256"
else
  echo "Install sha256sum or shasum so the download can be checked." >&2
  exit 1
fi

file="vmbridge-$os-$arch"
base="https://github.com/$repo/releases/latest/download"
mkdir -p "$dir"
tmp="$(mktemp "$dir/.vmbridge.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

echo "Downloading VM Bridge for $os-$arch..."
sums="$(curl -fsSL "$base/SHA256SUMS")"
curl -fSL --progress-bar "$base/$file" -o "$tmp"

# Lines look like "<hash>  <file>" (or "<hash> *<file>" in binary mode).
expected="$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f || $2 == "*" f { print $1; exit }')"
if [ -z "$expected" ]; then
  echo "The release has no checksum for $file. Nothing was changed." >&2
  exit 1
fi
actual="$($sha256 "$tmp" | awk '{ print $1 }')"
if [ "$actual" != "$expected" ]; then
  echo "The download does not match its checksum. Nothing was changed." >&2
  exit 1
fi
chmod 755 "$tmp"
# Check the download runs before it replaces a working install.
if ! version="$("$tmp" --version 2>/dev/null)"; then
  echo "The downloaded VM Bridge does not run on this machine. Nothing was changed." >&2
  exit 1
fi
mv "$tmp" "$dir/vmbridge"
trap - EXIT
# `vb` is its short name. Another program already called vb is left alone.
if [ ! -e "$dir/vb" ] || [ "$(readlink "$dir/vb")" = vmbridge ]; then ln -sf vmbridge "$dir/vb"; fi

echo "Installed VM Bridge $version to $dir/vmbridge"

case ":$PATH:" in
  *":$dir:"*) ;;
  *)
    echo
    echo "Add $dir to your PATH, for example:"
    echo "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.$(basename "${SHELL:-sh}")rc"
    ;;
esac

echo
echo "Start it with: vmbridge (or vb)"
echo "Keep it running in the background with: vmbridge service install"
