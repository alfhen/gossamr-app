#!/bin/sh
# A fake CLI whose script is data: a test links the fake's path to this file and writes the script beside it as
# `<path>.body`. macOS checks each new executable the first time it runs, a fraction of a second that grows into seconds
# when many tests write fakes at once; this one file is checked once, and every link to it runs at once.
exec /bin/sh "$0.body" "$@"
