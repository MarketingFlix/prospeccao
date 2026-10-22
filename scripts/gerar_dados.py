"""Gera um arquivo de comércios por cidade a partir do mapa do Brasil (OpenStreetMap).

Entrada: um .osm.pbf já filtrado pelo osmium (lojas, farmácias, restaurantes, ofícios e bairros).
Saída:   <saida>/<UF>/<codigo IBGE>.json  e  <saida>/indice.json

Uso:
    python scripts/gerar_dados.py brasil-filtrado.osm.pbf site/dados --cache cache-ibge

As cidades vêm da malha oficial do IBGE (mesmos códigos que o app usa na lista de cidades).
Os bairros vêm do próprio mapa: contornos de bairro, ou o ponto de bairro mais próximo.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import date

import osmium
from shapely import wkb
from shapely.geometry import Point, shape
from shapely.strtree import STRtree

# Sigla -> código IBGE da UF (os 2 primeiros dígitos do código de cada município).
CODIGOS_UF = {'RO': 11, 'AC': 12, 'AM': 13, 'RR': 14, 'PA': 15, 'AP': 16, 'TO': 17, 'MA': 21, 'PI': 22,
              'CE': 23, 'RN': 24, 'PB': 25, 'PE': 26, 'AL': 27, 'SE': 28, 'BA': 29, 'MG': 31, 'ES': 32,
              'RJ': 33, 'SP': 35, 'PR': 41, 'SC': 42, 'RS': 43, 'MS': 50, 'MT': 51, 'GO': 52, 'DF': 53}
UFS = list(CODIGOS_UF)
UF_POR_CODIGO = {str(v): k for k, v in CODIGOS_UF.items()}
IBGE_MALHA = ('https://servicodados.ibge.gov.br/api/v3/malhas/estados/{codigo}'
              '?formato=application/vnd.geo%2Bjson&intrarregiao=municipio&qualidade=intermediaria')
IBGE_MUNICIPIOS = 'https://servicodados.ibge.gov.br/api/v1/localidades/estados/{uf}/municipios'

AMENITIES = {'pharmacy', 'restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'ice_cream'}
LUGARES_BAIRRO = {'suburb', 'neighbourhood', 'quarter'}
DISTANCIA_MAX_BAIRRO = 0.02  # ~2 km, para ligar um comércio ao ponto de bairro mais próximo


# ---------- telefone e pontuação (mesma regra do app) ----------
def normalizar_telefone(bruto):
    d = re.sub(r'\D', '', str(bruto))
    if d.startswith('00'):
        d = d[2:]
    d = d.lstrip('0')
    if len(d) in (10, 11):
        d = '55' + d
    if not d.startswith('55') or len(d) not in (12, 13):
        return None
    if len(d) == 12 and d[4] in '6789':  # celular antigo sem o 9
        d = d[:4] + '9' + d[4:]
    return d


def eh_celular(d):
    return bool(d) and len(d) == 13 and d[4] == '9'


def extrair_contato(t):
    def separar(v):
        return [s.strip() for s in re.split(r'[;,/]', v or '') if s.strip()]
    declarados = [n for n in map(normalizar_telefone, separar(t.get('contact:whatsapp')) + separar(t.get('whatsapp'))) if n]
    outros = [n for k in ('mobile', 'contact:mobile', 'phone', 'contact:phone')
              for n in map(normalizar_telefone, separar(t.get(k))) if n]
    if declarados:
        return next((d for d in declarados if eh_celular(d)), declarados[0]), True, True
    cel = next((d for d in outros if eh_celular(d)), None)
    if cel:
        return cel, True, False
    if outros:
        return outros[0], False, False
    return None, False, False


def montar_loja(t, lon, lat):
    nome = t.get('name') or t.get('brand')
    if not nome:
        return None
    if 'shop' in t:
        chave = 'shop'
    elif t.get('amenity') in AMENITIES:
        chave = 'amenity'
    elif 'craft' in t:
        chave = 'craft'
    else:
        return None
    wa, zap, declarado = extrair_contato(t)
    extras = {
        's': t.get('website') or t.get('contact:website') or '',
        'm': t.get('email') or t.get('contact:email') or '',
        'h': t.get('opening_hours') or '',
        'r': t.get('contact:instagram') or t.get('contact:facebook') or t.get('instagram') or t.get('facebook') or '',
    }
    pontos = (5 if declarado else 4 if zap else 2 if wa else 0)
    pontos += bool(t.get('addr:street')) + bool(t.get('addr:housenumber')) + sum(bool(v) for v in extras.values())
    rua = ', '.join(x for x in (t.get('addr:street'), t.get('addr:housenumber')) if x)
    loja = {'n': nome, 'k': chave, 'v': t.get(chave), 'e': rua, 'p': pontos}
    if wa:
        loja['w'] = wa
        loja['z'] = 1 if zap else 0
    loja.update({k: v for k, v in extras.items() if v})
    return loja, lon, lat, t.get('addr:suburb')


# ---------- leitura do mapa ----------
class Coletor(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.lojas = []            # (loja, lon, lat, addr:suburb)
        self.bairros_area = []     # (nome, polígono)
        self.bairros_ponto = []    # (nome, lon, lat)
        self.municipios_osm = {}   # código IBGE -> (nome, polígono), plano B se a malha do IBGE não baixar
        self.fabrica = osmium.geom.WKBFactory()

    def node(self, n):
        t = dict(n.tags)
        if not n.location.valid():
            return
        r = montar_loja(t, n.location.lon, n.location.lat)
        if r:
            self.lojas.append(r)
        elif t.get('place') in LUGARES_BAIRRO and t.get('name'):
            self.bairros_ponto.append((t['name'], n.location.lon, n.location.lat))

    def way(self, w):
        t = dict(w.tags)
        if not (t.get('name') or t.get('brand')):
            return
        locs = [(nd.location.lon, nd.location.lat) for nd in w.nodes if nd.location.valid()]
        if not locs:
            return
        r = montar_loja(t, sum(x for x, _ in locs) / len(locs), sum(y for _, y in locs) / len(locs))
        if r:
            self.lojas.append(r)

    def area(self, a):
        t = dict(a.tags)
        nome = t.get('name')
        if not nome:
            return
        codigo = re.sub(r'\D', '', t.get('IBGE:GEOCODIGO', ''))
        if t.get('boundary') == 'administrative' and t.get('admin_level') == '8' and len(codigo) == 7:
            try:
                poli = wkb.loads(self.fabrica.create_multipolygon(a), hex=True)
                if not poli.is_empty:
                    self.municipios_osm[codigo] = (nome, poli if poli.is_valid else poli.buffer(0))
            except Exception:
                pass
            return
        eh_bairro = (t.get('boundary') == 'administrative' and t.get('admin_level') in ('9', '10')) or t.get('place') in LUGARES_BAIRRO
        if not eh_bairro:
            return
        try:
            poli = wkb.loads(self.fabrica.create_multipolygon(a), hex=True)
        except Exception:
            return
        if poli.is_valid and not poli.is_empty:
            self.bairros_area.append((nome, poli))


# ---------- IBGE ----------
def baixar_json(url, cache_dir, nome):
    caminho = os.path.join(cache_dir, nome)
    if os.path.exists(caminho):
        with open(caminho, encoding='utf-8') as f:
            return json.load(f)
    for tentativa in range(5):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                dados = json.loads(r.read().decode('utf-8'))
            break
        except Exception as e:
            if tentativa == 4:
                raise
            print(f'  falha ao baixar {nome} ({e}), tentando de novo...', file=sys.stderr)
            time.sleep(5 * (tentativa + 1))
    with open(caminho, 'w', encoding='utf-8') as f:
        json.dump(dados, f)
    return dados


def carregar_municipios(cache_dir, ufs, municipios_osm):
    """Contornos das cidades: malha oficial do IBGE; se não baixar, usa os limites do próprio mapa."""
    os.makedirs(cache_dir, exist_ok=True)
    municipios = []  # (codigo, uf, nome, geometria)
    for uf in ufs:
        try:
            nomes = {str(m['id']): m['nome'] for m in baixar_json(IBGE_MUNICIPIOS.format(uf=uf), cache_dir, f'municipios-{uf}.json')}
            malha = baixar_json(IBGE_MALHA.format(codigo=CODIGOS_UF[uf]), cache_dir, f'malha-{uf}.json')
            antes = len(municipios)
            for f in malha['features']:
                codigo = str(f['properties']['codarea'])
                municipios.append((codigo, uf, nomes.get(codigo, codigo), shape(f['geometry'])))
            print(f'  {uf}: {len(municipios) - antes} cidades (IBGE)', flush=True)
        except Exception as e:
            do_mapa = [(c, uf, n, g) for c, (n, g) in municipios_osm.items() if UF_POR_CODIGO.get(c[:2]) == uf]
            municipios.extend(do_mapa)
            print(f'::warning::{uf}: malha do IBGE indisponível ({e}); usando {len(do_mapa)} cidades do próprio mapa', flush=True)
    return municipios


# ---------- montagem ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pbf')
    ap.add_argument('saida')
    ap.add_argument('--cache', default='cache-ibge')
    ap.add_argument('--ufs', default=','.join(UFS), help='lista de UFs separadas por vírgula (padrão: todas)')
    args = ap.parse_args()

    print('Lendo o mapa...', flush=True)
    col = Coletor()
    col.apply_file(args.pbf, locations=True, idx='flex_mem')
    print(f'  {len(col.lojas)} comércios, {len(col.bairros_area)} contornos de bairro, {len(col.bairros_ponto)} pontos de bairro, '
          f'{len(col.municipios_osm)} cidades no mapa', flush=True)

    print('Carregando cidades do IBGE...', flush=True)
    municipios = carregar_municipios(args.cache, args.ufs.split(','), col.municipios_osm)
    arvore_mun = STRtree([m[3] for m in municipios])
    arvore_area = STRtree([b[1] for b in col.bairros_area]) if col.bairros_area else None
    arvore_ponto = STRtree([Point(b[1], b[2]) for b in col.bairros_ponto]) if col.bairros_ponto else None

    por_cidade = defaultdict(list)  # codigo -> [(loja, bairro)]
    sem_cidade = 0
    for loja, lon, lat, suburbio in col.lojas:
        p = Point(lon, lat)
        idx = [i for i in arvore_mun.query(p, predicate='intersects')]
        if not idx:
            sem_cidade += 1
            continue
        codigo = municipios[int(idx[0])][0]
        bairro = None
        if arvore_area is not None:
            dentro = [col.bairros_area[i] for i in arvore_area.query(p, predicate='intersects')]
            if dentro:
                bairro = min(dentro, key=lambda b: b[1].area)[0]  # o contorno mais específico
        if bairro is None and arvore_ponto is not None:
            i = arvore_ponto.nearest(p)
            nome, blon, blat = col.bairros_ponto[i]
            if abs(blon - lon) < DISTANCIA_MAX_BAIRRO and abs(blat - lat) < DISTANCIA_MAX_BAIRRO:
                bairro = nome
        if bairro is None and suburbio:
            bairro = suburbio
        por_cidade[codigo].append((loja, bairro))
    print(f'  {sem_cidade} comércios fora das cidades do IBGE (ignorados)', flush=True)

    info = {m[0]: (m[1], m[2]) for m in municipios}
    gerado = date.today().isoformat()
    indice = {'gerado': gerado, 'cidades': {}}
    for codigo, itens in por_cidade.items():
        uf, nome = info[codigo]
        bairros = sorted({b for _, b in itens if b}, key=lambda s: s.casefold())
        pos = {b: i for i, b in enumerate(bairros)}
        lojas = []
        for loja, b in sorted(itens, key=lambda x: (-x[0]['p'], x[0]['n'].casefold())):
            if b is not None:
                loja = {**loja, 'b': pos[b]}
            lojas.append(loja)
        pasta = os.path.join(args.saida, uf)
        os.makedirs(pasta, exist_ok=True)
        with open(os.path.join(pasta, f'{codigo}.json'), 'w', encoding='utf-8') as f:
            json.dump({'cidade': nome, 'uf': uf, 'gerado': gerado, 'bairros': bairros, 'lojas': lojas},
                      f, ensure_ascii=False, separators=(',', ':'))
        indice['cidades'][codigo] = len(lojas)
    os.makedirs(args.saida, exist_ok=True)
    with open(os.path.join(args.saida, 'indice.json'), 'w', encoding='utf-8') as f:
        json.dump(indice, f, separators=(',', ':'))
    total = sum(indice['cidades'].values())
    print(f'::notice::Pronto: {total} comércios em {len(por_cidade)} cidades ({sem_cidade} fora das cidades).', flush=True)


if __name__ == '__main__':
    main()
