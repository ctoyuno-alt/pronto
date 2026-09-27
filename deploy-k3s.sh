#!/usr/bin/env bash
# ==============================================================================
# Pronto k3s Automated Deployment Script
# ==============================================================================
set -e

NAMESPACE="pronto"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🚀 Starting Pronto deployment on k3s..."

# 1. Check prerequisites
if ! command -v kubectl &> /dev/null; then
    echo "❌ Error: kubectl is not installed or not in PATH."
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo "❌ Error: node is not installed or not in PATH."
    exit 1
fi

# 2. Build Docker container image
echo "📦 Building Docker image pronto-app:local..."
if command -v docker &> /dev/null; then
    docker build -t pronto-app:local "$SCRIPT_DIR"
    
    # If running k3s directly, import image into k3s containerd store
    if command -v k3s &> /dev/null; then
        echo "📥 Importing image into k3s image store..."
        docker save pronto-app:local | sudo k3s ctr images import -
    fi
else
    echo "⚠️ Docker not found. Assuming pronto-app:local is already available in your k3s cluster or registry."
fi

# 3. Create Namespace
echo "🔧 Applying Namespace..."
kubectl apply -f "$SCRIPT_DIR/k8s/00-namespace.yaml"

# 4. Generate Secrets if placeholders are detected
SECRETS_FILE="$SCRIPT_DIR/k8s/01-configmap-secrets.yaml"
if grep -q "REPLACE_WITH_GENERATED" "$SECRETS_FILE"; then
    echo "🔐 Generating unique JWT keys and secrets..."
    
    JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    POSTGRES_PASS=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
    CRON_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    INTERNAL_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    
    # Generate anon and service_role tokens using helper script
    KEYS_JSON=$(node "$SCRIPT_DIR/scripts/generate-k8s-keys.js" "$JWT_SECRET")
    ANON_KEY=$(echo "$KEYS_JSON" | grep -A1 "NEXT_PUBLIC_SUPABASE_ANON_KEY:" | tail -n1)
    SERVICE_KEY=$(echo "$KEYS_JSON" | grep -A1 "SUPABASE_SERVICE_ROLE_KEY:" | tail -n1)
    
    # Create temporary secrets manifest with generated values
    TMP_SECRETS=$(mktemp)
    sed \
      -e "s|POSTGRES_PASSWORD: \".*\"|POSTGRES_PASSWORD: \"$POSTGRES_PASS\"|g" \
      -e "s|DATABASE_URL: \".*\"|DATABASE_URL: \"postgresql://postgres:$POSTGRES_PASS@pronto-postgres:5432/postgres?sslmode=disable\"|g" \
      -e "s|GOTRUE_DB_DATABASE_URL: \".*\"|GOTRUE_DB_DATABASE_URL: \"postgres://postgres:$POSTGRES_PASS@pronto-postgres:5432/postgres?sslmode=disable\"|g" \
      -e "s|GOTRUE_JWT_SECRET: \".*\"|GOTRUE_JWT_SECRET: \"$JWT_SECRET\"|g" \
      -e "s|NEXT_PUBLIC_SUPABASE_ANON_KEY: \".*\"|NEXT_PUBLIC_SUPABASE_ANON_KEY: \"$ANON_KEY\"|g" \
      -e "s|SUPABASE_SERVICE_ROLE_KEY: \".*\"|SUPABASE_SERVICE_ROLE_KEY: \"$SERVICE_KEY\"|g" \
      -e "s|CRON_SECRET: \".*\"|CRON_SECRET: \"$CRON_SECRET\"|g" \
      -e "s|INTERNAL_API_SECRET: \".*\"|INTERNAL_API_SECRET: \"$INTERNAL_SECRET\"|g" \
      "$SECRETS_FILE" > "$TMP_SECRETS"
      
    kubectl apply -f "$TMP_SECRETS"
    rm -f "$TMP_SECRETS"
else
    echo "🔑 Applying ConfigMap and Secrets..."
    kubectl apply -f "$SECRETS_FILE"
fi

# 5. Apply PostgreSQL & Auth
echo "🗄️ Deploying PostgreSQL..."
kubectl apply -f "$SCRIPT_DIR/k8s/02-postgres.yaml"

echo "⏳ Waiting for PostgreSQL to be ready..."
kubectl rollout status statefulset/pronto-postgres -n "$NAMESPACE" --timeout=120s

echo "🔑 Deploying Supabase Auth (GoTrue)..."
kubectl apply -f "$SCRIPT_DIR/k8s/03-supabase-auth.yaml"
kubectl rollout status deployment/pronto-auth -n "$NAMESPACE" --timeout=120s

# 6. Apply Migration Job
echo "🔄 Running database migration job..."
# Delete old job if it exists to allow re-run
kubectl delete job pronto-migrate -n "$NAMESPACE" --ignore-not-found
kubectl apply -f "$SCRIPT_DIR/k8s/04-migrate-job.yaml"

echo "⏳ Waiting for migration job to complete..."
kubectl wait --for=condition=complete job/pronto-migrate -n "$NAMESPACE" --timeout=180s

# 7. Deploy App & Ingress & CronJob
echo "🖥️ Deploying Pronto Application..."
kubectl apply -f "$SCRIPT_DIR/k8s/05-pronto-app.yaml"
kubectl rollout status deployment/pronto-app -n "$NAMESPACE" --timeout=120s

echo "🌐 Applying Ingress & CronJob..."
kubectl apply -f "$SCRIPT_DIR/k8s/06-ingress.yaml"
kubectl apply -f "$SCRIPT_DIR/k8s/07-cron-job.yaml"

echo ""
echo "🎉 Pronto deployment on k3s complete!"
echo "Check pods status with:"
echo "  kubectl get pods -n pronto"
