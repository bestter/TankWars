#!/bin/bash
curl -s -X POST http://localhost:8787/api/rooms \
  -H "Content-Type: application/json" \
  -d '{"numPlayers":2, "origin": "javascript:alert(1);//"}' | grep javascript
