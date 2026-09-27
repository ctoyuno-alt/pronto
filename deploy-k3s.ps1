# ==============================================================================
# Pronto k3s Automated Deployment Script (PowerShell for Windows)
# ==============================================================================
$ErrorActionPreference = "Stop"

$Namespace = "pronto"
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Get-Location }

Write-Host "Starting Pronto deployment on k3s..." -ForegroundColor Cyan

# 1. Check prerequisites
if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
    Write-Host "Error: kubectl is not installed or not in PATH." -ForegroundColor Red
    exit 1
}

# Helper to generate random hex strings
function New-RandomHex([int]$length = 32) {
    $bytes = New-Object byte[] $length
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return ([System.BitConverter]::ToString($bytes) -replace '-','').ToLower()
}

# Helper to generate JWT tokens
function New-SupabaseJwt {
    param(
        [string]$Role,
        [string]$Secret
    )
    $header = '{"alg":"HS256","typ":"JWT"}'
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $exp = $now + (10 * 365 * 86400)
    $payload = '{"role":"' + $Role + '","iss":"supabase","iat":' + $now + ',"exp":' + $exp + '}'

    $bHeader = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($header)).TrimEnd('=').Replace('+','-').Replace('/','_')
    $bPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload)).TrimEnd('=').Replace('+','-').Replace('/','_')
    $inputStr = "$bHeader.$bPayload"

    $hmac = [Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($Secret))
    $sig = [Convert]::ToBase64String($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($inputStr))).TrimEnd('=').Replace('+','-').Replace('/','_')

    return "$inputStr.$sig"
}

# 2. Create Namespace
Write-Host "Applying Namespace..." -ForegroundColor Yellow
kubectl apply -f "$ScriptDir/k8s/00-namespace.yaml"

# 3. Check and generate secrets if placeholders exist
$SecretsPath = Join-Path $ScriptDir "k8s/01-configmap-secrets.yaml"
$SecretsContent = Get-Content $SecretsPath -Raw

if ($SecretsContent.Contains("REPLACE_WITH_GENERATED")) {
    Write-Host "Generating unique JWT keys and database secrets..." -ForegroundColor Yellow
    
    $JwtSecret = New-RandomHex 32
    $DbPassword = New-RandomHex 16
    $CronSecret = New-RandomHex 32
    $InternalSecret = New-RandomHex 32

    $AnonKey = New-SupabaseJwt -Role "anon" -Secret $JwtSecret
    $ServiceRoleKey = New-SupabaseJwt -Role "service_role" -Secret $JwtSecret

    $SecretsContent = $SecretsContent -replace 'POSTGRES_PASSWORD:\s*".*"', "POSTGRES_PASSWORD: `"$DbPassword`""
    $SecretsContent = $SecretsContent -replace 'DATABASE_URL:\s*".*"', "DATABASE_URL: `"postgresql://postgres:${DbPassword}@pronto-postgres:5432/postgres?sslmode=disable`""
    $SecretsContent = $SecretsContent -replace 'GOTRUE_DB_DATABASE_URL:\s*".*"', "GOTRUE_DB_DATABASE_URL: `"postgres://postgres:${DbPassword}@pronto-postgres:5432/postgres?sslmode=disable`""
    $SecretsContent = $SecretsContent -replace 'GOTRUE_JWT_SECRET:\s*".*"', "GOTRUE_JWT_SECRET: `"$JwtSecret`""
    $SecretsContent = $SecretsContent -replace 'NEXT_PUBLIC_SUPABASE_ANON_KEY:\s*".*"', "NEXT_PUBLIC_SUPABASE_ANON_KEY: `"$AnonKey`""
    $SecretsContent = $SecretsContent -replace 'SUPABASE_SERVICE_ROLE_KEY:\s*".*"', "SUPABASE_SERVICE_ROLE_KEY: `"$ServiceRoleKey`""
    $SecretsContent = $SecretsContent -replace 'CRON_SECRET:\s*".*"', "CRON_SECRET: `"$CronSecret`""
    $SecretsContent = $SecretsContent -replace 'INTERNAL_API_SECRET:\s*".*"', "INTERNAL_API_SECRET: `"$InternalSecret`""

    $TempFile = [System.IO.Path]::GetTempFileName()
    Set-Content -Path $TempFile -Value $SecretsContent -Encoding UTF8
    kubectl apply -f $TempFile
    Remove-Item $TempFile -ErrorAction SilentlyContinue
} else {
    Write-Host "Applying ConfigMap and Secrets..." -ForegroundColor Yellow
    kubectl apply -f "$ScriptDir/k8s/01-configmap-secrets.yaml"
}

# Deploy Internal Registry
Write-Host "Deploying Internal Container Registry..." -ForegroundColor Yellow
kubectl apply -f "$ScriptDir/k8s/01-registry.yaml"
kubectl rollout status deployment/pronto-registry -n $Namespace --timeout=60s

# 4. Deploy PostgreSQL
Write-Host "Deploying PostgreSQL..." -ForegroundColor Yellow
kubectl apply -f "$ScriptDir/k8s/02-postgres.yaml"

Write-Host "Waiting for PostgreSQL pod to start..." -ForegroundColor Gray
kubectl rollout status statefulset/pronto-postgres -n $Namespace --timeout=120s

# 5. Deploy Supabase Auth (GoTrue)
Write-Host "Deploying Supabase Auth (GoTrue)..." -ForegroundColor Yellow
kubectl apply -f "$ScriptDir/k8s/03-supabase-auth.yaml"
kubectl rollout status deployment/pronto-auth -n $Namespace --timeout=120s

# 6. Run Database Migrations Job
Write-Host "Running database migration job..." -ForegroundColor Yellow
kubectl delete job pronto-migrate -n $Namespace --ignore-not-found | Out-Null
kubectl apply -f "$ScriptDir/k8s/04-migrate-job.yaml"

Write-Host "Waiting for migration job to complete..." -ForegroundColor Gray
try {
    kubectl wait --for=condition=complete job/pronto-migrate -n $Namespace --timeout=180s
} catch {
    Write-Host "Migration job incomplete or failed. Checking job logs..." -ForegroundColor Red
    kubectl logs job/pronto-migrate -n $Namespace
}

# 7. Deploy App, Ingress, and CronJob
Write-Host "Deploying Pronto Application..." -ForegroundColor Yellow
kubectl apply -f "$ScriptDir/k8s/05-pronto-app.yaml"
kubectl rollout status deployment/pronto-app -n $Namespace --timeout=120s

Write-Host "Applying Ingress and CronJob..." -ForegroundColor Yellow
kubectl apply -f "$ScriptDir/k8s/06-ingress.yaml"
kubectl apply -f "$ScriptDir/k8s/07-cron-job.yaml"

Write-Host ""
Write-Host "Pronto deployment on k3s complete!" -ForegroundColor Green
Write-Host "Checking pod status:" -ForegroundColor Cyan
kubectl get pods -n $Namespace
