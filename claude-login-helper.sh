#!/bin/bash
# Helper script for headless claude auth login
# Uses a named pipe to control stdin

rm -f /tmp/claude-fifo /tmp/claude-login-out.txt
mkfifo /tmp/claude-fifo

# Keep the write end of the FIFO open so the read side doesn't get EOF
sleep 300 > /tmp/claude-fifo &
KEEPALIVE_PID=$!

# Start login reading from the FIFO
claude auth login --claudeai < /tmp/claude-fifo > /tmp/claude-login-out.txt 2>&1 &
LOGIN_PID=$!

echo "KEEPALIVE_PID=$KEEPALIVE_PID"
echo "LOGIN_PID=$LOGIN_PID"

# Wait for output
sleep 5
cat /tmp/claude-login-out.txt
