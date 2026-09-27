# 🚀 Deploying Pronto on k3s (Truly Self-Hosted)

This guide walks you through deploying **Pronto** completely self-hosted inside a **k3s** (or any Kubernetes) cluster with zero external dependencies on SaaS platforms like Supabase.com.

---

## 🏗️ Architecture Overview

The k3s deployment consists of 6 self-contained components running inside the `pronto` namespace:

```
                    ┌─────────────────────────┐
                    │     Traefik Ingress     │
                    └────────────┬────────────┘
                                 │
                   ┌─────────────┴─────────────┐
                   ▼                           ▼
        ┌─────────────────────┐     ┌─────────────────────┐
        │     pronto-app      │     │     pronto-auth     │
        │   (Next.js App)     │     │  (Supabase GoTrue)  │
        └──────────┬──────────┘     └──────────┬──────────┘
                   │                           │
                   └─────────────┬─────────────┘
                                 ▼
                    ┌─────────────────────────┐
                    │     pronto-postgres     │
                    │   (PostgreSQL + Data)   │
                    └─────────────────────────┘
```

1. **`pronto-postgres`**: PostgreSQL database with `auth` schema initialization and persistent storage (`local-path` PVC).
2. **`pronto-auth`**: Lightweight Supabase GoTrue Auth service for user registration and JWT authentication.
3. **`pronto-migrate`**: One-shot Kubernetes `Job` that automatically runs schema migrations on cluster startup.
4. **`pronto-app`**: The Next.js business management web application.
5. **`pronto-cron-notify`**: Kubernetes `CronJob` running every 15 minutes to trigger booking reminders and stock alerts.
6. **`pronto-ingress`**: Traefik Ingress for web traffic routing with optional SSL certificate support.

---

## 🛠️ Step 1: Generate Cryptographic Secrets

Run the built-in key generator to create matching JWT tokens (`anon` and `service_role` keys):

```bash
node scripts/generate-k8s-keys.js --env
```

Copy the generated secrets into [`k8s/01-configmap-secrets.yaml`](file:///d:/main-data/pronto/k8s/01-configmap-secrets.yaml).

---

## 📦 Step 2: Build & Import Image into k3s

Build the production Docker image locally on your node:

```bash
docker build -t pronto-app:local .
```

If you are using k3s with the default containerd runtime, import the built image directly:

```bash
docker save pronto-app:local | sudo k3s ctr images import -
```

---

## 🚀 Step 3: Deploy to k3s

You can deploy automatically using the provided script:

```bash
chmod +x deploy-k3s.sh
./deploy-k3s.sh
```

Or manually apply the manifests:

```bash
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/01-configmap-secrets.yaml
kubectl apply -f k8s/02-postgres.yaml
kubectl apply -f k8s/03-supabase-auth.yaml
kubectl apply -f k8s/04-migrate-job.yaml
kubectl apply -f k8s/05-pronto-app.yaml
kubectl apply -f k8s/06-ingress.yaml
kubectl apply -f k8s/07-cron-job.yaml
```

---

## 🔍 Step 4: Verify Deployment

Check that all pods and services are running:

```bash
kubectl get pods -n pronto
```

Expected output:

```
NAME                              READY   STATUS      RESTARTS   AGE
pod/pronto-postgres-0             1/1     Running     0          1m
pod/pronto-auth-xxx-yyy           1/1     Running     0          1m
pod/pronto-migrate-zzz            0/1     Completed   0          45s
pod/pronto-app-aaa-bbb            1/1     Running     0          30s
```

Check logs for the migration job:

```bash
kubectl logs job/pronto-migrate -n pronto
```

---

## 🔒 Step 5: Configure Domain & HTTPS (Optional)

Edit [`k8s/06-ingress.yaml`](file:///d:/main-data/pronto/k8s/06-ingress.yaml) to map your domain:

```yaml
spec:
  rules:
    - host: mysalon.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: pronto-app
                port:
                  number: 3000
```

If you have **Cert-Manager** installed in k3s, uncomment the TLS annotations in [`k8s/06-ingress.yaml`](file:///d:/main-data/pronto/k8s/06-ingress.yaml) for automatic Let's Encrypt SSL certificates.

---

## 💾 Backup & Restore

### Database Backup
```bash
kubectl exec -it pronto-postgres-0 -n pronto -- pg_dump -U postgres postgres > pronto_backup.sql
```

### Database Restore
```bash
cat pronto_backup.sql | kubectl exec -i pronto-postgres-0 -n pronto -- psql -U postgres postgres
```

---

## ❓ Troubleshooting

- **Migration Job FAILED**:
  Inspect migration logs: `kubectl logs job/pronto-migrate -n pronto`. Ensure `pronto-postgres` service is reachable on port 5432.
- **Login/Register error**:
  Check `pronto-auth` logs: `kubectl logs deployment/pronto-auth -n pronto`. Ensure `GOTRUE_JWT_SECRET` in `pronto-secrets` matches the secret used to generate `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
