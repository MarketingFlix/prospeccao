"""Gera os arquivos de comércios do app a partir da base aberta de CNPJ da Receita Federal.

Entrada: a pasta com os .zip do mês (Estabelecimentos*.zip, Empresas*.zip, Municipios.zip, Cnaes.zip),
         baixados de https://arquivos.receitafederal.gov.br/index.php/s/YggdBLfdninEJX9
Saída:
    <saida>/indice.json                 {"gerado", "fonte", "ufs": {UF: quantidade}}
    <saida>/cnaes.json                  {código CNAE: tipo legível}
    <saida>/<UF>/cidades.json           [[código, nome, quantidade], ...]
    <saida>/<UF>/<código>/bairros.json  {"cidade", "uf", "bairros": [[nome, quantidade], ...]}
    <saida>/<UF>/<código>/todos.json    melhores comércios da cidade (lista)
    <saida>/<UF>/<código>/<i>.json      melhores comércios do bairro i

Só entram estabelecimentos ativos, com telefone e com atividade principal de comércio (ou alimentação e
serviços, que o app mostra como opcionais). Cada lista vem ordenada pelo ranking: dados mais completos primeiro.

Uso:
    python scripts/gerar_dados_cnpj.py receita/ saida/
"""
import argparse
import csv
import glob
import io
import json
import os
import re
import sys
import zipfile
from collections import Counter, defaultdict
from datetime import date

csv.field_size_limit(10_000_000)

MAX_BAIRRO = 80    # comércios por arquivo de bairro
MAX_CIDADE = 150   # comércios no arquivo "cidade toda"
TELEFONE_REPETIDO = 4  # o mesmo número em tantas empresas costuma ser do contador


# ---------- atividade (CNAE) -> grupo do app ----------
def grupo_da_cnae(c):
    if c.startswith(('4711', '4712', '4721', '4722', '4723', '4724', '4729')):
        return 'mercado'
    if c.startswith(('4781', '4782', '4783')):
        return 'moda'
    if c.startswith(('4741', '4742', '4743', '4744', '4754', '4755', '4759')):
        return 'casa'
    if c.startswith(('4751', '4752', '4753', '4756', '4757')):
        return 'eletro'
    if c.startswith(('4771', '4772', '4773', '4774')):
        return 'farmacia'
    if c in ('4511101', '4511102', '4530703', '4530705', '4541203', '4541205', '4541206') or c.startswith(('4731', '4732')):
        return 'auto'
    if c.startswith('47'):
        return 'outras'
    if c.startswith(('5611', '5620')) or c == '1091102':
        return 'alimentacao'
    if c.startswith(('9602', '4520', '9511', '9512', '9521', '9529', '9601')):
        return 'servicos'
    return None


def tipo_legivel(descricao):
    d = descricao.strip()
    if ' - ' in d:
        d = d.rsplit(' - ', 1)[1]
    d = re.sub(r'^(Comércio varejista d[eoa]s?|Comércio a varejo d[eoa]s?)\s+', '', d, flags=re.I)
    d = d[:1].lower() + d[1:]
    return d if len(d) <= 45 else d[:44].rstrip(' ,') + '…'


# ---------- telefone e textos ----------
def normalizar_telefone(ddd, numero):
    d = re.sub(r'\D', '', (ddd or '') + (numero or '')).lstrip('0')
    if len(d) not in (10, 11):
        return None
    d = '55' + d
    if len(d) == 12 and d[4] in '6789':  # celular antigo sem o 9
        d = d[:4] + '9' + d[4:]
    return d


def email_proprio(email):
    """E-mail da própria empresa; os de escritório de contabilidade ficam de fora."""
    e = (email or '').strip().lower()
    return '' if not e or re.search(r'contab|fiscal|escritorio|assessoria', e) else e


def eh_celular(d):
    return bool(d) and len(d) == 13 and d[4] == '9'


MINUSCULAS = {'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'a', 'o', 'na', 'no'}
SIGLAS = {'ltda', 'me', 'epp', 'eireli', 'sa', 's/a', 'mei'}


def bonito(texto):
    palavras = re.sub(r'\s+', ' ', texto or '').strip().lower().split(' ')
    saida = []
    for i, p in enumerate(palavras):
        if p in SIGLAS:
            saida.append(p.upper())
        elif i and p in MINUSCULAS:
            saida.append(p)
        else:
            saida.append(p[:1].upper() + p[1:])
    return ' '.join(saida).strip()


def ler_csv(caminho_zip):
    with zipfile.ZipFile(caminho_zip) as z:
        for nome in z.namelist():
            with z.open(nome) as f:
                yield from csv.reader(io.TextIOWrapper(f, encoding='latin-1', newline=''), delimiter=';', quotechar='"')


def arquivos(pasta, prefixo):
    achados = sorted(glob.glob(os.path.join(pasta, f'{prefixo}*.zip')))
    if not achados:
        sys.exit(f'::error::Nenhum arquivo {prefixo}*.zip em {pasta}')
    return achados


# ---------- montagem ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pasta')
    ap.add_argument('saida')
    ap.add_argument('--fonte', default='Receita Federal (dados abertos do CNPJ)')
    args = ap.parse_args()

    municipios = {r[0]: bonito(r[1]) for r in ler_csv(arquivos(args.pasta, 'Municipios')[0]) if len(r) >= 2}
    cnaes = {r[0]: tipo_legivel(r[1]) for r in ler_csv(arquivos(args.pasta, 'Cnaes')[0]) if len(r) >= 2}

    print('Lendo estabelecimentos...', flush=True)
    lojas = []   # [cnpj_basico, nome, cnae, uf, municipio, bairro, endereco, tel, tel2, email]
    lidos = 0
    for caminho in arquivos(args.pasta, 'Estabelecimentos'):
        for r in ler_csv(caminho):
            lidos += 1
            if len(r) < 28 or r[5] != '02':
                continue
            cnae = r[11]
            if not grupo_da_cnae(cnae):
                continue
            t1 = normalizar_telefone(r[21], r[22])
            t2 = normalizar_telefone(r[23], r[24])
            if not (t1 or t2):
                continue
            if not t1 or (t2 and eh_celular(t2) and not eh_celular(t1)):
                t1, t2 = t2, t1
            rua = ' '.join(x for x in (r[13], r[14]) if x.strip())
            endereco = ', '.join(x for x in (bonito(rua), r[15].strip() if r[15].strip() not in ('', 'S/N', 'SN') else '') if x)
            lojas.append([r[0], bonito(r[4]), cnae, r[19], r[20], bonito(r[17]), endereco, t1, t2 if t2 != t1 else None,
                          email_proprio(r[27])])
        print(f'  {os.path.basename(caminho)}: {len(lojas)} comércios com telefone até agora ({lidos} lidos)', flush=True)

    sem_nome = {l[0] for l in lojas if not l[1]}
    print(f'Buscando a razão social de {len(sem_nome)} empresas sem nome fantasia...', flush=True)
    razao = {}
    for caminho in arquivos(args.pasta, 'Empresas'):
        for r in ler_csv(caminho):
            if r and r[0] in sem_nome:
                razao[r[0]] = bonito(re.sub(r'^[\d.\s]+|[\s\d.\-]+$', '', r[1]))  # MEI: tira o CNPJ do começo e o CPF do fim
    for l in lojas:
        if not l[1]:
            l[1] = razao.get(l[0], '')
    lojas = [l for l in lojas if l[1]]

    repetidos = Counter(l[7] for l in lojas)
    por_cidade = defaultdict(list)
    for cnpj, nome, cnae, uf, mun, bairro, endereco, t1, t2, email in lojas:
        contador = repetidos[t1] >= TELEFONE_REPETIDO
        pontos = (4 if eh_celular(t1) else 2) - (4 if contador else 0)
        pontos += bool(t2) + bool(email) + bool(endereco) + bool(bairro)
        loja = {'n': nome, 'g': grupo_da_cnae(cnae), 'c': cnae, 'e': endereco, 'w': t1, 'p': pontos}
        if t2:
            loja['w2'] = t2
        if email:
            loja['m'] = email
        if contador:
            loja['x'] = 1
        por_cidade[(uf, mun)].append((loja, bairro))

    gerado = date.today().isoformat()
    os.makedirs(args.saida, exist_ok=True)
    ordem = lambda item: (-item[0]['p'], item[0]['n'].casefold())
    cidades_uf = defaultdict(list)
    total = 0
    for (uf, mun), itens in por_cidade.items():
        if uf not in UFS:
            continue
        pasta = os.path.join(args.saida, uf, mun)
        os.makedirs(pasta, exist_ok=True)
        contagem = Counter(b for _, b in itens if b)
        bairros = sorted(contagem, key=lambda s: s.casefold())
        pos = {b: i for i, b in enumerate(bairros)}
        grupos = defaultdict(list)
        todos = []
        for loja, b in sorted(itens, key=ordem):
            if b:
                loja = {**loja, 'b': pos[b]}
                if len(grupos[pos[b]]) < MAX_BAIRRO:
                    grupos[pos[b]].append(loja)
            if len(todos) < MAX_CIDADE:
                todos.append(loja)
        nome = municipios.get(mun, mun)
        gravar(os.path.join(pasta, 'bairros.json'),
               {'cidade': nome, 'uf': uf, 'gerado': gerado, 'total': len(itens), 'bairros': [[b, contagem[b]] for b in bairros]})
        gravar(os.path.join(pasta, 'todos.json'), todos)
        for i, lista in grupos.items():
            gravar(os.path.join(pasta, f'{i}.json'), lista)
        cidades_uf[uf].append([mun, nome, len(itens)])
        total += len(itens)

    for uf, cidades in cidades_uf.items():
        gravar(os.path.join(args.saida, uf, 'cidades.json'), sorted(cidades, key=lambda c: c[1].casefold()))
    usados = {l[2] for l in lojas}
    gravar(os.path.join(args.saida, 'cnaes.json'), {c: t for c, t in cnaes.items() if c in usados})
    gravar(os.path.join(args.saida, 'indice.json'),
           {'gerado': gerado, 'fonte': args.fonte, 'ufs': {uf: sum(c[2] for c in cs) for uf, cs in sorted(cidades_uf.items())}})
    print(f'::notice::Pronto: {total} comércios com telefone em {sum(map(len, cidades_uf.values()))} cidades.', flush=True)


UFS = {'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
       'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'}


def gravar(caminho, dados):
    with open(caminho, 'w', encoding='utf-8') as f:
        json.dump(dados, f, ensure_ascii=False, separators=(',', ':'))


if __name__ == '__main__':
    main()
