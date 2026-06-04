#!/usr/bin/env bash
# Peakr — one-shot Stripe setup. Creates the $9/mo recurring Product/Price and
# a Webhook Endpoint pointing at your /billing/webhook function, then prints
# the IDs/secrets you need to drop into Supabase Edge Function secrets.
#
# Usage:
#   STRIPE_SECRET_KEY=sk_test_xxx \
#   WEBHOOK_URL=https://<PROJECT_REF>.functions.supabase.co/api/billing/webhook \
#   bash bin/setup-stripe.sh
#
# Optional overrides:
#   PRICE_CENTS=900           # $9.00
#   INTERVAL=month            # month | year
#   PRODUCT_NAME="Peakr Pro"
set -euo pipefail

: "${STRIPE_SECRET_KEY:?must be set to your sk_live_ or sk_test_ key}"
: "${WEBHOOK_URL:?must be the full https URL of your /billing/webhook function}"

PRICE_CENTS=${PRICE_CENTS:-900}
INTERVAL=${INTERVAL:-month}
PRODUCT_NAME=${PRODUCT_NAME:-Peakr Pro}

curl_stripe() { curl -fsS -u "$STRIPE_SECRET_KEY:" "$@"; }

echo "→ Creating product '$PRODUCT_NAME'..."
PRODUCT_ID=$(curl_stripe https://api.stripe.com/v1/products \
  --data-urlencode "name=$PRODUCT_NAME" | jq -r .id)
echo "  product:  $PRODUCT_ID"

echo "→ Creating recurring price ($((PRICE_CENTS/100)).$(printf '%02d' $((PRICE_CENTS%100))) / $INTERVAL)..."
PRICE_ID=$(curl_stripe https://api.stripe.com/v1/prices \
  -d "product=$PRODUCT_ID" -d "unit_amount=$PRICE_CENTS" -d "currency=usd" \
  -d "recurring[interval]=$INTERVAL" | jq -r .id)
echo "  price:    $PRICE_ID"

echo "→ Creating webhook endpoint at $WEBHOOK_URL ..."
WEBHOOK_JSON=$(curl_stripe https://api.stripe.com/v1/webhook_endpoints \
  -d "url=$WEBHOOK_URL" \
  -d "enabled_events[]=checkout.session.completed" \
  -d "enabled_events[]=customer.subscription.created" \
  -d "enabled_events[]=customer.subscription.updated" \
  -d "enabled_events[]=customer.subscription.deleted")
WEBHOOK_ID=$(echo "$WEBHOOK_JSON" | jq -r .id)
WEBHOOK_SECRET=$(echo "$WEBHOOK_JSON" | jq -r .secret)
echo "  webhook:  $WEBHOOK_ID"

cat <<EOF

✅ Done. Add these to your Supabase Edge Function secrets:

  supabase secrets set \\
    STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY" \\
    STRIPE_PRICE_ID="$PRICE_ID" \\
    STRIPE_WEBHOOK_SECRET="$WEBHOOK_SECRET"

Then redeploy the api function:
  supabase functions deploy api

Verify everything end-to-end with:
  API=$(dirname "$WEBHOOK_URL" | sed 's|/billing||') \\
  ADMIN_KEY=... POSTBACK_SECRET=... STRIPE_WEBHOOK_SECRET="$WEBHOOK_SECRET" \\
  bash bin/smoke-test.sh
EOF
