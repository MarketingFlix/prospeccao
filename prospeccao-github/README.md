# Prospecção PVA

App web (instalável no Android) para a equipe de vendas de rua:

1. Escolhe UF, cidade e bairro.
2. Lista os comércios da área (10, 20 ou 30), com os cadastros mais completos primeiro.
3. "Enviar mensagem para lista": abre o WhatsApp / WhatsApp Business já na conversa de cada comércio, com a mensagem pronta.
4. Exporta contatos (.vcf, prefixo "PVA") e planilha (.csv).

Custo: zero. Os dados vêm do OpenStreetMap e as listas ficam só no celular de cada vendedor.

## Como funciona

- `app/`: o app (HTML, CSS e JavaScript puro, sem build).
- `scripts/gerar_dados.py`: lê o mapa do Brasil e gera `dados/<UF>/<código IBGE>.json` para cada cidade.
- `.github/workflows/publicar.yml`: todo dia 3 baixa o mapa, gera os dados (branch `dados`) e publica tudo no GitHub Pages.
  Mudanças em `app/` republicam o app na hora, reaproveitando os dados.

## Primeira configuração (uma vez)

1. Settings > Pages > Build and deployment > Source: **GitHub Actions**.
2. Actions > "Dados e publicação" > **Run workflow** (deixe "gerar dados" marcado). Leva uns 30 minutos.
3. O link do app aparece no fim da execução: `https://<usuario>.github.io/prospeccao/`.

## Instalar no celular

Abrir o link no Chrome do Android > menu ⋮ > "Adicionar à tela inicial".

## Boas práticas de envio

- WhatsApp Business em chip da empresa, com perfil completo.
- Apresente-se, diga de onde tirou o contato e ofereça a opção de não receber mais.
- Ritmo humano: poucas dezenas de mensagens novas por dia por número.
- Marque "Não contatar" para quem pedir.

Dados © colaboradores do OpenStreetMap (licença ODbL).
