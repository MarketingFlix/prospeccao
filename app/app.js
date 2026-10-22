// Prospecção PVA: busca comércios (dados do OpenStreetMap, gerados todo mês por scripts/gerar_dados.py),
// monta listas e envia mensagens pelo WhatsApp.
// Tudo roda no navegador do celular; os dados ficam salvos só no aparelho (localStorage).

const IBGE_MUNICIPIOS = uf => `https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios`;
const DADOS = 'dados'; // pasta publicada junto com o app: dados/indice.json e dados/<UF>/<código IBGE>.json

// Tipos de comércio a partir da etiqueta do mapa. As de venda vêm marcadas; alimentação e serviços ficam opcionais.
const SERVICOS = 'hairdresser|beauty|massage|tattoo|car_repair|laundry|dry_cleaning|funeral_directors|travel_agency|tailor|copyshop|money_lender|pawnbroker|rental|vacant';
const valor = lista => { const re = new RegExp(`^(${lista})$`); return v => !!v && re.test(v); };
const ehServico = valor(SERVICOS);
const CATEGORIAS = [
  { id: 'mercado', rotulo: 'Mercados e padarias', marcada: true, aceita: t => valor('supermarket|convenience|bakery|butcher|greengrocer|deli|beverages|alcohol|confectionery|pastry|seafood|frozen_food|wholesale')(t.shop) },
  { id: 'moda', rotulo: 'Roupas e calçados', marcada: true, aceita: t => valor('clothes|shoes|boutique|jewelry|bag|fashion_accessories|watches|fabric')(t.shop) },
  { id: 'casa', rotulo: 'Casa e construção', marcada: true, aceita: t => valor('hardware|doityourself|furniture|paint|houseware|interior_decoration|electrical|appliance|bathroom_furnishing|kitchen|lighting|flooring|garden_centre|trade|glaziery')(t.shop) },
  { id: 'eletro', rotulo: 'Celulares e eletrônicos', marcada: true, aceita: t => valor('mobile_phone|electronics|computer|hifi')(t.shop) },
  { id: 'farmacia', rotulo: 'Farmácias e cosméticos', marcada: true, aceita: t => t.amenity === 'pharmacy' || valor('chemist|cosmetics|perfumery|optician|medical_supply')(t.shop) },
  { id: 'auto', rotulo: 'Autopeças e motos', marcada: true, aceita: t => valor('car_parts|tyres|motorcycle|bicycle|car')(t.shop) },
  { id: 'outras', rotulo: 'Outras lojas', marcada: true, aceita: t => !!t.shop && !ehServico(t.shop) },
  { id: 'alimentacao', rotulo: 'Bares e restaurantes', marcada: false, aceita: t => valor('restaurant|cafe|fast_food|bar|pub|ice_cream')(t.amenity) },
  { id: 'servicos', rotulo: 'Serviços e beleza', marcada: false, aceita: t => ehServico(t.shop) || !!t.craft },
];

const UFS = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal',
  ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais',
  PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte',
  RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};

const MENSAGEM_PADRAO =
  'Olá, tudo bem? Aqui é da [EMPRESA]. Encontrei a {nome} no mapa da região e queria apresentar rapidamente nossa proposta para comércios do bairro. ' +
  'Posso te mandar os detalhes? Se preferir não receber mensagens, é só me avisar.';

// ---------- armazenamento ----------
const db = {
  ler(chave, padrao) {
    try { const v = localStorage.getItem(chave); return v ? JSON.parse(v) : padrao; } catch { return padrao; }
  },
  gravar(chave, valor) {
    try { localStorage.setItem(chave, JSON.stringify(valor)); } catch (e) { alert('Não foi possível salvar no aparelho: ' + e.message); }
  },
};
let listas = db.ler('pva.listas', []);
let listaAtualId = db.ler('pva.listaAtual', null);
const salvarListas = () => db.gravar('pva.listas', listas);
const listaAtual = () => listas.find(l => l.id === listaAtualId);
const mensagem = () => db.ler('pva.mensagem', MENSAGEM_PADRAO);

// ---------- utilidades ----------
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hoje = () => new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const ehAndroid = /Android/i.test(navigator.userAgent);

// "+55 31 98765-4321", "(31) 8765-4321", "031 98765 4321" -> "5531987654321" (ou null se não for número BR válido)
function normalizarTelefone(bruto) {
  let d = String(bruto).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  d = d.replace(/^0+/, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  if (!d.startsWith('55') || (d.length !== 12 && d.length !== 13)) return null;
  // celular antigo sem o 9 na frente: 55 31 8765-4321 -> 55 31 98765-4321
  if (d.length === 12 && /[6-9]/.test(d[4])) d = d.slice(0, 4) + '9' + d.slice(4);
  return d;
}
const ehCelular = d => d && d.length === 13 && d[4] === '9';
function formatarTelefone(d) {
  if (!d) return '';
  const ddd = d.slice(2, 4), n = d.slice(4);
  return `(${ddd}) ${n.slice(0, n.length - 4)}-${n.slice(-4)}`;
}

const TIPOS = {
  restaurant: 'restaurante', cafe: 'café', fast_food: 'lanchonete', bar: 'bar', pub: 'bar', ice_cream: 'sorveteria',
  supermarket: 'supermercado', convenience: 'conveniência', bakery: 'padaria', butcher: 'açougue', greengrocer: 'hortifruti',
  beverages: 'bebidas', alcohol: 'bebidas', confectionery: 'doceria', pastry: 'confeitaria', hairdresser: 'salão',
  beauty: 'estética', cosmetics: 'cosméticos', pharmacy: 'farmácia', chemist: 'drogaria', clinic: 'clínica',
  dentist: 'dentista', doctors: 'consultório', veterinary: 'veterinário', optician: 'ótica', clothes: 'roupas',
  shoes: 'calçados', mobile_phone: 'celulares', electronics: 'eletrônicos', hardware: 'ferragens', pet: 'pet shop',
  florist: 'floricultura', variety_store: 'variedades', car_repair: 'oficina', car_wash: 'lava-jato', fuel: 'posto',
  furniture: 'móveis', jewelry: 'joalheria', stationery: 'papelaria', books: 'livraria', gift: 'presentes', kiosk: 'banca',
};
const tipoLegivel = t => TIPOS[t] || String(t).replace(/_/g, ' ');

// ---------- dados da cidade ----------
let indice = null;       // { gerado, cidades: { código: quantidade } }
let cidadeAtual = null;  // conteúdo de dados/<UF>/<código>.json

async function carregarIndice() {
  if (indice) return indice;
  try {
    const r = await fetch(`${DADOS}/indice.json`, { cache: 'no-cache' });
    indice = r.ok ? await r.json() : { cidades: {} };
  } catch {
    indice = { cidades: {} };
  }
  if (indice.gerado) $('#data-dados').textContent = `Dados do mapa de ${new Date(indice.gerado + 'T12:00').toLocaleDateString('pt-BR')}.`;
  return indice;
}

async function carregarCidade() {
  const uf = $('#uf').value, codigo = $('#cidade').value;
  const sel = $('#bairro'), aviso = $('#aviso-bairros');
  sel.innerHTML = '<option value="">Cidade toda</option>';
  sel.disabled = true;
  cidadeAtual = null;
  if (!uf || !codigo) { aviso.textContent = ''; return; }
  aviso.textContent = 'Carregando comércios da cidade...';
  try {
    const r = await fetch(`${DADOS}/${uf}/${codigo}.json`);
    if (r.status === 404) throw new Error('vazio');
    if (!r.ok) throw new Error(`erro ${r.status}`);
    const dados = await r.json();
    if ($('#cidade').value !== codigo) return; // trocou de cidade enquanto carregava
    cidadeAtual = { ...dados, codigo };
  } catch (e) {
    if ($('#cidade').value !== codigo) return;
    aviso.textContent = e.message === 'vazio'
      ? 'O mapa ainda não tem comércios cadastrados nesta cidade.'
      : 'Não consegui carregar os dados da cidade. Verifique a internet e escolha a cidade de novo.';
    return;
  }
  const porBairro = new Map();
  for (const l of cidadeAtual.lojas) if (l.b != null) porBairro.set(l.b, (porBairro.get(l.b) || 0) + 1);
  sel.innerHTML = '<option value="">Cidade toda</option>' + cidadeAtual.bairros
    .map((nome, i) => [nome, i])
    .filter(([, i]) => porBairro.has(i))
    .map(([nome, i]) => `<option value="${i}">${esc(nome)} (${porBairro.get(i)})</option>`).join('');
  sel.disabled = false;
  aviso.textContent = `${cidadeAtual.lojas.length} comércios no mapa desta cidade, em ${porBairro.size} bairros.`;
  const ultima = db.ler('pva.ultimaBusca', {});
  if (ultima.cidade === codigo && ultima.bairro) {
    const i = cidadeAtual.bairros.indexOf(ultima.bairro);
    if (i >= 0 && porBairro.has(i)) sel.value = String(i);
  }
}

// ---------- busca ----------
function buscar() {
  const uf = $('#uf').value;
  const codigo = $('#cidade').value;
  const escolhaBairro = $('#bairro').value;
  const quantidade = Number($('#quantidade').value);
  const escolhidas = CATEGORIAS.filter(c => $(`#cat-${c.id}`).checked);
  const status = $('#status-busca');
  status.classList.remove('erro');
  const erro = msg => { status.textContent = msg; status.classList.add('erro'); };
  if (!uf || !codigo) return erro('Escolha a UF e a cidade.');
  if (!cidadeAtual || cidadeAtual.codigo !== codigo) return erro('Aguarde carregar os dados da cidade.');
  if (!escolhidas.length) return erro('Escolha pelo menos um tipo de comércio.');

  const cidade = cidadeAtual.cidade;
  const bairroIdx = escolhaBairro === '' ? null : Number(escolhaBairro);
  const bairro = bairroIdx == null ? '' : cidadeAtual.bairros[bairroIdx];
  db.gravar('pva.ultimaBusca', { uf, cidade: codigo, bairro, quantidade });

  // O arquivo já vem ordenado pelo ranking (dados mais completos primeiro).
  const encontrados = cidadeAtual.lojas
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => (bairroIdx == null || l.b === bairroIdx) && escolhidas.some(c => c.aceita({ [l.k]: l.v })));
  const selecionados = encontrados.slice(0, quantidade).map(({ l, i }) => ({
    id: `${codigo}-${i}`,
    nome: l.n,
    tipo: tipoLegivel(l.v),
    end: [l.e, l.b != null ? cidadeAtual.bairros[l.b] : ''].filter(Boolean).join(' - '),
    wa: l.w || null, zap: !!l.z,
    site: l.s || '', email: l.m || '', horario: l.h || '', social: l.r || '',
    pontos: l.p, status: 'pendente',
  }));
  if (!selecionados.length) return erro('Nenhum comércio encontrado com esses filtros. Tente outro bairro ou mais tipos de comércio.');

  const destino = bairro ? `${bairro}, ${cidade} - ${uf}` : `${cidade} - ${uf}`;
  const lista = { id: String(Date.now()), nome: `${bairro ? bairro + ' - ' : ''}${cidade}/${uf} ${hoje()}`, destino, criadaEm: new Date().toISOString(), itens: selecionados };
  listas.unshift(lista);
  listaAtualId = lista.id;
  salvarListas();
  db.gravar('pva.listaAtual', listaAtualId);
  const comTel = selecionados.filter(i => i.wa).length;
  status.textContent = `${encontrados.length} comércios encontrados; lista "${lista.nome}" criada com ${selecionados.length} (${comTel} com telefone).`;
  mostrarAba('listas');
}

// ---------- WhatsApp ----------
function linkWhatsApp(wa, texto) {
  const t = encodeURIComponent(texto);
  // No Android o esquema whatsapp:// abre o app direto (o Android pergunta qual, se tiver o comum e o Business).
  return ehAndroid ? `whatsapp://send?phone=${wa}&text=${t}` : `https://wa.me/${wa}?text=${t}`;
}
function abrirWhatsApp(item) {
  const url = linkWhatsApp(item.wa, mensagem().replaceAll('{nome}', item.nome));
  if (window.__abrirLink) window.__abrirLink(url); // usado só nos testes automatizados
  else window.location.href = url;
}

// ---------- modo sequência ----------
let seq = null; // { pulados: Set, ultimo: nome do último aberto }

function proximoDaFila() {
  const l = listaAtual();
  return l && l.itens.find(i => i.wa && i.status === 'pendente' && !seq.pulados.has(i.id));
}

function iniciarSequencia() {
  const l = listaAtual();
  if (!l) return;
  const pendentes = l.itens.filter(i => i.wa && i.status === 'pendente').length;
  if (!pendentes) { alert('Ninguém pendente com telefone nesta lista.'); return; }
  if (mensagem() === MENSAGEM_PADRAO && !confirm('Você ainda está usando a mensagem de exemplo. Continuar mesmo assim?\n(Para editar, vá na aba Mensagem.)')) return;
  seq = { pulados: new Set(), ultimo: null };
  $('#sequencia').hidden = false;
  desenharSequencia();
}

function desenharSequencia() {
  const l = listaAtual();
  const comTel = l.itens.filter(i => i.wa && i.status !== 'nao');
  const enviados = comTel.filter(i => i.status === 'enviado').length;
  $('#seq-progresso').textContent = `${enviados} de ${comTel.length} enviados`;
  $('#seq-barra').style.width = comTel.length ? `${(100 * enviados) / comTel.length}%` : '0';
  $('#seq-anterior').textContent = seq.ultimo ? `✓ Aberto para ${seq.ultimo}` : '';
  const prox = proximoDaFila();
  if (!prox) {
    $('#seq-nome').textContent = 'Lista concluída 🎉';
    $('#seq-tel').textContent = 'Todos os contatos com telefone já foram abertos.';
    $('#seq-abrir').hidden = true;
    $('#seq-pular').hidden = true;
    $('#seq-pausar').textContent = 'Fechar';
    return;
  }
  $('#seq-nome').textContent = prox.nome;
  $('#seq-tel').textContent = formatarTelefone(prox.wa) + (prox.zap ? ' · provável WhatsApp' : ' · telefone fixo, pode não ter WhatsApp');
  $('#seq-abrir').hidden = false;
  $('#seq-pular').hidden = false;
  $('#seq-pausar').textContent = 'Pausar';
}

function abrirProximo() {
  const prox = proximoDaFila();
  if (!prox) return;
  prox.status = 'enviado';
  prox.enviadoEm = new Date().toISOString();
  salvarListas();
  seq.ultimo = prox.nome;
  abrirWhatsApp(prox);
  desenharSequencia();
}

function pararSequencia() {
  seq = null;
  $('#sequencia').hidden = true;
  desenharLista();
}

// ---------- listas ----------
function desenharSeletor() {
  const sel = $('#seletor-lista');
  sel.innerHTML = listas.map(l => `<option value="${l.id}">${esc(l.nome)} (${l.itens.length})</option>`).join('');
  if (!listaAtual() && listas.length) listaAtualId = listas[0].id;
  sel.value = listaAtualId || '';
}

function desenharLista() {
  const temListas = listas.length > 0;
  $('#sem-listas').hidden = temListas;
  for (const id of ['#seletor-lista', '#resumo-lista', '#btn-enviar-lista', '#btn-vcf', '#btn-csv', '#btn-excluir', '#itens']) $(id).hidden = !temListas;
  $('.filtro').hidden = !temListas;
  if (!temListas) return;
  desenharSeletor();
  const l = listaAtual();
  const comTel = l.itens.filter(i => i.wa);
  const enviados = l.itens.filter(i => i.status === 'enviado').length;
  const pendentes = comTel.filter(i => i.status === 'pendente').length;
  $('#resumo-lista').textContent =
    `${l.itens.length} comércios · ${comTel.length} com telefone · ${enviados} enviados · ${pendentes} pendentes · ${l.itens.length - comTel.length} sem telefone`;
  $('#btn-enviar-lista').textContent = enviados ? `Continuar envio (${pendentes} pendentes)` : 'Enviar mensagem para lista';

  const soComTel = $('#so-com-tel').checked;
  $('#itens').innerHTML = l.itens
    .filter(i => !soComTel || i.wa)
    .map(i => {
      const selo = i.status === 'enviado' ? '<span class="selo enviado">enviado</span>'
        : i.status === 'nao' ? '<span class="selo nao">não contatar</span>'
        : i.zap ? '<span class="selo zap">provável WhatsApp</span>' : '';
      const botoes = [];
      if (i.wa && i.status !== 'nao') botoes.push(`<button data-acao="zap" data-id="${i.id}">${i.status === 'enviado' ? 'Reenviar' : 'WhatsApp'}</button>`);
      if (!i.wa) botoes.push(`<button data-acao="maps" data-id="${i.id}">Ver no Google Maps</button>`);
      botoes.push(`<button data-acao="tel" data-id="${i.id}">${i.wa ? 'Editar telefone' : 'Adicionar telefone'}</button>`);
      botoes.push(i.status === 'nao'
        ? `<button data-acao="reativar" data-id="${i.id}">Reativar</button>`
        : `<button data-acao="nao" data-id="${i.id}" class="perigo">Não contatar</button>`);
      return `<li>
        <div class="item-nome">${esc(i.nome)}${selo}</div>
        <div class="item-info">${esc([i.tipo, i.end].filter(Boolean).join(' · '))}</div>
        <div class="item-tel">${i.wa ? esc(formatarTelefone(i.wa)) : '<span class="item-info">sem telefone no mapa</span>'}</div>
        ${i.site || i.email || i.horario || i.social ? `<div class="item-info">também tem: ${[i.site && 'site', i.email && 'e-mail', i.horario && 'horário', i.social && 'rede social'].filter(Boolean).join(', ')}</div>` : ''}
        <div class="item-acoes">${botoes.join('')}</div>
      </li>`;
    })
    .join('');
}

function acaoItem(acao, id) {
  const l = listaAtual();
  const item = l.itens.find(i => i.id === id);
  if (!item) return;
  if (acao === 'zap') {
    item.status = 'enviado';
    item.enviadoEm = new Date().toISOString();
    salvarListas();
    abrirWhatsApp(item);
  } else if (acao === 'maps') {
    const q = [item.nome, item.end, l.destino].filter(Boolean).join(', ');
    window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`, '_blank');
  } else if (acao === 'tel') {
    const novo = prompt(`Telefone de ${item.nome} (com DDD):`, item.wa ? formatarTelefone(item.wa) : '');
    if (novo === null) return;
    if (!novo.trim()) { item.wa = null; item.zap = false; }
    else {
      const d = normalizarTelefone(novo);
      if (!d) { alert('Número inválido. Use DDD + número, ex.: 31 98765-4321'); return; }
      item.wa = d;
      item.zap = ehCelular(d);
    }
    salvarListas();
  } else if (acao === 'nao') {
    item.status = 'nao';
    salvarListas();
  } else if (acao === 'reativar') {
    item.status = 'pendente';
    salvarListas();
  }
  desenharLista();
}

function baixar(nomeArquivo, conteudo, tipo) {
  const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
  const a = Object.assign(document.createElement('a'), { href: url, download: nomeArquivo });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const nomeArquivo = l => l.nome.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

function exportarVcf() {
  const l = listaAtual();
  const v = s => String(s).replace(/([\\,;])/g, '\\$1');
  const cartoes = l.itens
    .filter(i => i.wa && i.status !== 'nao')
    .map(i => ['BEGIN:VCARD', 'VERSION:3.0', `FN:PVA ${v(i.nome)}`, `N:;PVA ${v(i.nome)};;;`, `ORG:${v(i.nome)}`, `TEL;TYPE=CELL:+${i.wa}`, 'END:VCARD'].join('\r\n'));
  if (!cartoes.length) { alert('Nenhum contato com telefone nesta lista.'); return; }
  baixar(`${nomeArquivo(l)}.vcf`, cartoes.join('\r\n') + '\r\n', 'text/vcard');
}

function exportarCsv() {
  const l = listaAtual();
  const c = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const linhas = l.itens.map(i => [i.nome, i.tipo, i.end, i.wa ? formatarTelefone(i.wa) : '', i.wa ? `https://wa.me/${i.wa}` : '', i.site, i.email, i.horario, i.social, i.status].map(c).join(';'));
  baixar(`${nomeArquivo(l)}.csv`, '﻿' + ['nome;tipo;endereco;telefone;whatsapp;site;email;horario;rede_social;status', ...linhas].join('\r\n'), 'text/csv');
}

function excluirLista() {
  const l = listaAtual();
  if (!l || !confirm(`Excluir a lista "${l.nome}"?`)) return;
  listas = listas.filter(x => x.id !== l.id);
  listaAtualId = listas[0]?.id || null;
  salvarListas();
  db.gravar('pva.listaAtual', listaAtualId);
  desenharLista();
}

// ---------- abas e eventos ----------
function mostrarAba(aba) {
  for (const b of document.querySelectorAll('nav button')) b.classList.toggle('ativa', b.dataset.aba === aba);
  for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== `aba-${aba}`;
  if (aba === 'listas') desenharLista();
  window.scrollTo(0, 0);
}

// Cidades da UF (lista oficial do IBGE, mesmos códigos dos arquivos de dados), com a quantidade de comércios no mapa.
async function carregarCidades(uf, selecionar) {
  const sel = $('#cidade');
  sel.innerHTML = '<option value="">Escolha a cidade</option>';
  sel.disabled = true;
  carregarCidade();
  if (!uf) return;
  let cidades = db.ler(`pva.municipios.${uf}`, null);
  if (!cidades) {
    try {
      const r = await fetch(IBGE_MUNICIPIOS(uf));
      cidades = (await r.json()).map(m => ({ id: String(m.id), nome: m.nome })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
      db.gravar(`pva.municipios.${uf}`, cidades);
    } catch {
      $('#aviso-bairros').textContent = 'Não consegui carregar as cidades. Verifique a internet e escolha a UF de novo.';
      return;
    }
  }
  const { cidades: qtd } = await carregarIndice();
  if ($('#uf').value !== uf) return;
  sel.innerHTML += cidades.map(c => `<option value="${c.id}">${esc(c.nome)}${qtd[c.id] ? ` (${qtd[c.id]})` : ' (sem dados)'}</option>`).join('');
  sel.disabled = false;
  if (selecionar && cidades.some(c => c.id === selecionar)) { sel.value = selecionar; carregarCidade(); }
}

function iniciar() {
  $('#categorias').innerHTML = CATEGORIAS.map(c =>
    `<label><input type="checkbox" id="cat-${c.id}"${c.marcada ? ' checked' : ''}><span>${esc(c.rotulo)}</span></label>`).join('');
  $('#uf').innerHTML = '<option value="">UF</option>' + Object.keys(UFS).map(uf => `<option>${uf}</option>`).join('');
  const ultima = db.ler('pva.ultimaBusca', {});
  if (ultima.uf) { $('#uf').value = ultima.uf; carregarCidades(ultima.uf, ultima.cidade); }
  if ([10, 20, 30].includes(ultima.quantidade)) $('#quantidade').value = String(ultima.quantidade);
  $('#uf').addEventListener('change', e => carregarCidades(e.target.value));
  $('#cidade').addEventListener('change', carregarCidade);
  carregarIndice();
  $('#mensagem').value = mensagem();

  for (const b of document.querySelectorAll('nav button')) b.addEventListener('click', () => mostrarAba(b.dataset.aba));
  $('#btn-buscar').addEventListener('click', buscar);
  $('#seletor-lista').addEventListener('change', e => { listaAtualId = e.target.value; db.gravar('pva.listaAtual', listaAtualId); desenharLista(); });
  $('#so-com-tel').addEventListener('change', desenharLista);
  $('#itens').addEventListener('click', e => { const b = e.target.closest('button[data-acao]'); if (b) acaoItem(b.dataset.acao, b.dataset.id); });
  $('#btn-enviar-lista').addEventListener('click', iniciarSequencia);
  $('#btn-vcf').addEventListener('click', exportarVcf);
  $('#btn-csv').addEventListener('click', exportarCsv);
  $('#btn-excluir').addEventListener('click', excluirLista);
  $('#btn-salvar-msg').addEventListener('click', () => {
    db.gravar('pva.mensagem', $('#mensagem').value.trim() || MENSAGEM_PADRAO);
    $('#status-msg').textContent = 'Mensagem salva.';
  });
  $('#seq-abrir').addEventListener('click', abrirProximo);
  $('#seq-pular').addEventListener('click', () => { const p = proximoDaFila(); if (p) seq.pulados.add(p.id); seq.ultimo = null; desenharSequencia(); });
  $('#seq-pausar').addEventListener('click', pararSequencia);
  // Ao voltar do WhatsApp, o painel já mostra o próximo da fila.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && seq) desenharSequencia(); });

  if (listas.length) mostrarAba('listas');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

iniciar();
