# Prospecção PVA

App web (instalável no Android) para a equipe de vendas de rua:

1. Escolhe UF, cidade e bairro.
2. Lista os comércios da área (10, 20 ou 30), com os cadastros mais completos primeiro.
3. "Enviar mensagem para lista": abre o WhatsApp / WhatsApp Business já na conversa de cada comércio, com a mensagem pronta.
4. Exporta contatos (.vcf, prefixo "PVA") e planilha (.csv).

Custo: zero. Os dados vêm da base aberta de CNPJ da Receita Federal (empresas ativas, com telefone) e as listas
ficam só no celular de cada vendedor.

## Como funciona

- `app/`: o app (HTML, CSS e JavaScript puro, sem build).
- `scripts/gerar_dados_cnpj.py`: lê a base de CNPJ e gera `dados/<UF>/<cidade>/` com os bairros e os melhores
  comércios de cada bairro (celular, e-mail e endereço primeiro; números repetidos em muitas empresas, geralmente do
  contador, vão para o fim).
- `.github/workflows/publicar.yml`: todo dia 20 baixa a base do mês, gera os dados (branch `dados-receita`) e publica
  tudo no GitHub Pages.
  Mudanças em `app/` republicam o app na hora, reaproveitando os dados.

## Primeira configuração (uma vez)

1. Settings > Pages > Build and deployment > Source: **GitHub Actions**.
2. Actions > "Dados e publicação" > **Run workflow** (deixe "gerar dados" marcado). Leva de 1 a 3 horas (a base tem uns 6 GB).
3. O link do app aparece no fim da execução: `https://<usuario>.github.io/prospeccao/`.

## Instalar no celular

Abrir o link no Chrome do Android > menu ⋮ > "Adicionar à tela inicial".

## Boas práticas de envio

- WhatsApp Business em chip da empresa, com perfil completo.
- Apresente-se, diga de onde tirou o contato e ofereça a opção de não receber mais.
- Ritmo humano: poucas dezenas de mensagens novas por dia por número.
- Marque "Não contatar" para quem pedir.

Dados: Receita Federal do Brasil, Cadastro Nacional da Pessoa Jurídica (dados abertos). São dados públicos de
empresas, mas continuam valendo a LGPD e as regras do WhatsApp: use para contato comercial, com opção de sair.
