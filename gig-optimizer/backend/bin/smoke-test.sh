#!/usr/bin/env bash
# Peakr — live backend smoke test. Runs the whole loop against a deployed
# Supabase project so you can confirm everything works before real users.
#
# Required env:
#   API              https://<PROJECT_REF>.functions.supabase.co/api
#   ADMIN_KEY        operator analytics key
#   POSTBACK_SECRET  referral conversion shared secret
# Optional:
#   STRIPE_WEBHOOK_SECRET  if set, exercises /billing/webhook with a signed event
#
# Exits 0 on success, non-zero with the failing step shown.
set -euo pipefail

: "${API:?must be set to the api base URL}"
: "${ADMIN_KEY:?required}"
: "${POSTBACK_SECRET:?required}"

step()  { printf "\n[%s] %s\n" "$(date +%H:%M:%S)" "$*"; }
ok()    { echo "  ✓ $*"; }
fail()  { echo "  ✗ $*"; exit 1; }
status() { [ "$1" = "$2" ] || fail "expected HTTP $2, got $1"; }

step "1. Public market model"
RESP=$(curl -sS -w "\n%{http_code}" "$API/market-model?market=nash")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
status "$CODE" "200"
echo "$BODY" | jq -e '.market == "nash" and (.byPlatform | type) == "object"' >/dev/null \
  || fail "shape: $BODY"
ok "market-model OK · drivers=$(echo "$BODY" | jq .drivers)"

step "2. Anonymous device token"
TOKEN=$(curl -sS -X POST "$API/auth/anon" | jq -r .token)
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || fail "no token issued"
ok "token issued"

step "3. /me reflects new driver"
ME=$(curl -sS -H "Authorization: Bearer $TOKEN" "$API/me")
DRIVER_ID=$(echo "$ME" | jq -r .driver_id)
[ -n "$DRIVER_ID" ] && [ "$DRIVER_ID" != "null" ] || fail "no driver_id"
ok "driver_id=$DRIVER_ID  tier=$(echo "$ME" | jq -r .tier)"

step "4. Log a session"
CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$API/sessions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"date":"2026-05-25","platform":"uber","startHour":17,"hours":5,"actualGross":150,"predictedGross":175,"market":"nash"}')
status "$CODE" "201"
COUNT=$(curl -sS -H "Authorization: Bearer $TOKEN" "$API/sessions" | jq 'length')
[ "$COUNT" -ge 1 ] || fail "session not stored"
ok "session stored · count=$COUNT"

step "5. Referral click returns a tracking subid"
URL=$(curl -sS -X POST "$API/referrals/click" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"platform":"spark","market":"nash"}' | jq -r .url)
echo "$URL" | grep -q "subid=" || fail "no subid in URL: $URL"
SUBID=${URL##*subid=}
SUBID=${SUBID%%&*}
ok "tracked · subid=$SUBID"

step "6. Conversion postback marks the click"
CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$API/referrals/postback" \
  -H "x-postback-secret: $POSTBACK_SECRET" -H "Content-Type: application/json" \
  -d "{\"subid\":\"$SUBID\",\"payout_cents\":25000}")
status "$CODE" "200"
ok "postback accepted"

step "7. Operator analytics"
A=$(curl -sS -H "x-admin-key: $ADMIN_KEY" "$API/admin/analytics")
SESSIONS=$(echo "$A" | jq .sessions)
CONVERSIONS=$(echo "$A" | jq .conversions)
[ "$CONVERSIONS" -ge 1 ] || fail "conversion missing from analytics: $A"
ok "sessions=$SESSIONS  conversions=$CONVERSIONS"

if [ -n "${STRIPE_WEBHOOK_SECRET:-}" ]; then
  step "8. Stripe webhook: signed event flips tier → pro"
  PAYLOAD='{"id":"evt_smoke","type":"checkout.session.completed","data":{"object":{"client_reference_id":"'"$DRIVER_ID"'","customer":"cus_smoke","subscription":"sub_smoke"}}}'
  T=$(date +%s)
  SIG=$(printf '%s.%s' "$T" "$PAYLOAD" \
    | openssl dgst -sha256 -hmac "$STRIPE_WEBHOOK_SECRET" \
    | awk -F'= ' '{print $2}' | tr -d ' ')
  CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$API/billing/webhook" \
    -H "stripe-signature: t=$T,v1=$SIG" -H "Content-Type: application/json" \
    --data-binary "$PAYLOAD")
  status "$CODE" "200"
  TIER=$(curl -sS -H "Authorization: Bearer $TOKEN" "$API/me" | jq -r .tier)
  [ "$TIER" = "pro" ] || fail "tier did not flip to pro (got: $TIER)"
  ok "webhook verified · tier=pro"
else
  echo "(skip 8 — STRIPE_WEBHOOK_SECRET not set)"
fi

printf "\n🎉 Backend smoke test passed.\n"
