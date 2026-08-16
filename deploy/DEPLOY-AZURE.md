# Publicar o PromoShop em uma Azure VM

Este roteiro considera Ubuntu Server 24.04, usuário SSH `azureuser`, código em um GitHub privado e IA externa.

## 1. Criar a VM

- Imagem: Ubuntu Server 24.04 LTS.
- Tamanho inicial: 2 vCPU e 4 GB de memória.
- Disco: Standard SSD com pelo menos 64 GB.
- Portas públicas: 22, 80 e 443.
- IP público: estático.
- Não habilite desligamento automático.

## 2. Entrar e instalar os programas

Entre por SSH e execute:

```bash
sudo apt update
sudo apt install -y git nginx curl ca-certificates certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
curl -fsSLO https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb
```

## 3. Criar o usuário e baixar o código

```bash
sudo useradd --system --create-home --shell /bin/bash promoshop
sudo mkdir -p /var/www/promoshop
sudo chown -R promoshop:promoshop /var/www/promoshop
```

Configure uma chave de implantação somente para leitura no repositório privado e clone o projeto em `/var/www/promoshop`. Depois:

```bash
cd /var/www/promoshop
sudo -u promoshop npm ci
sudo -u promoshop npm run build
```

## 4. Levar os dados privados

Transfira por SFTP, sem passar pelo GitHub:

- `data/db.json`
- `data/secrets.enc`
- `data/.secret-key`

Os três arquivos precisam permanecer juntos. Depois ajuste a propriedade:

```bash
sudo chown -R promoshop:promoshop /var/www/promoshop/data
sudo chmod 600 /var/www/promoshop/data/.secret-key /var/www/promoshop/data/secrets.enc
```

Não transfira a sessão do WhatsApp criada no Windows. Faça uma nova conexão pelo painel depois que o site estiver no ar.

## 5. Configurar o ambiente e o serviço

Copie `deploy/.env.production.example` para `/var/www/promoshop/.env`, substitua `SEU_DOMINIO` e gere o `AUTH_SECRET` com `openssl rand -hex 32`.

```bash
sudo cp /var/www/promoshop/deploy/promoshop.service /etc/systemd/system/promoshop.service
sudo systemctl daemon-reload
sudo systemctl enable --now promoshop
sudo systemctl status promoshop
```

O serviço reinicia o site em caso de falha. O próprio site restaura o publicador do WhatsApp quando `Iniciar automaticamente` estiver ligado no painel.

## 6. Configurar domínio e HTTPS

Troque `SEU_DOMINIO` no arquivo `deploy/nginx-promoshop.conf`, copie-o e ative-o:

```bash
sudo cp /var/www/promoshop/deploy/nginx-promoshop.conf /etc/nginx/sites-available/promoshop
sudo ln -s /etc/nginx/sites-available/promoshop /etc/nginx/sites-enabled/promoshop
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

No provedor do domínio, aponte os registros A de `@` e `www` para o IP estático da VM. Quando o domínio responder, ative HTTPS:

```bash
sudo certbot --nginx -d SEU_DOMINIO -d www.SEU_DOMINIO
```

## 7. Conferência

1. Abra `https://SEU_DOMINIO/api/health` e confirme `ok: true`.
2. Entre em `https://SEU_DOMINIO/admin`.
3. Troque a senha administrativa.
4. Configure e teste a chave da IA externa.
5. Conecte o WhatsApp por QR Code.
6. Selecione os grupos e mantenha `Iniciar automaticamente` ligado.
7. Faça uma publicação imediata e outra agendada.

## Atualizações futuras

Depois de enviar uma atualização ao GitHub:

```bash
cd /var/www/promoshop
sudo -u promoshop git pull --ff-only
sudo -u promoshop npm ci
sudo -u promoshop npm run build
sudo systemctl restart promoshop
```

Faça backup periódico de `data/` e `.wwebjs_auth/`. Não inclua essas pastas no repositório.
