// Robô diário da arara: busca os posts mais recentes no feed JSON do Behold,
// baixa as fotos para assets/looks/ e reescreve assets/looks/looks.js.
// Uso: BEHOLD_FEED_URL="https://feeds.behold.so/..." node scripts/atualizar-looks.mjs
// Uma consulta por execução, para caber no plano grátis do Behold.

import { readFile, writeFile, readdir, unlink } from "node:fs/promises";

const FEED = process.env.BEHOLD_FEED_URL;
const PASTA = "assets/looks";
const ARQUIVO = `${PASTA}/looks.js`;
const MAXIMO = 12;            // quantos looks ficam pendurados na arara
const LIMITE_FOTO = 8 * 1024 * 1024;

if (!FEED) {
  console.error("Defina BEHOLD_FEED_URL com o endereço do feed JSON do Behold.");
  process.exit(1);
}

async function lerAtuais() {
  try {
    const texto = await readFile(ARQUIVO, "utf8");
    return JSON.parse(texto.slice(texto.indexOf("["), texto.lastIndexOf("]") + 1));
  } catch {
    return [];
  }
}

// Posts que não são look (avisos, sorteios, divulgação do site) ficam fora da arara:
// basta a legenda ter a hashtag #DeladanyAvisa, em qualquer lugar, maiúscula ou minúscula.
const HASHTAG_FORA = "deladanyavisa";
function ficaForaDaArara(post) {
  const tags = [...String(post.caption || "").matchAll(/#([\p{L}\p{N}_]+)/gu)].map(m => m[1].toLowerCase());
  const extras = (post.hashtags || []).map(t => String(t).replace(/^#/, "").toLowerCase());
  return [...tags, ...extras].includes(HASHTAG_FORA);
}

function codigoDoLink(link) {
  return String(link || "").match(/\/(?:reel|reels|p|tv)\/([^/?#]+)/)?.[1] || null;
}

// Primeira linha da legenda vira o nome da peça na arara, sem emojis.
function nomeDaLegenda(legenda) {
  const linha = String(legenda || "")
    .split("\n")
    .map(l => l.replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}️‍]/gu, "").replace(/\s+/g, " ").trim())
    .find(l => l.length > 0) || "";
  if (!linha) return "Novidade da semana";
  if (linha.length <= 48) return linha;
  const corte = linha.slice(0, 48);
  return corte.slice(0, Math.max(corte.lastIndexOf(" "), 30)).trim() + "…";
}

function urlDaFoto(post) {
  const s = post.sizes || {};
  return s.large?.mediaUrl || s.full?.mediaUrl || s.medium?.mediaUrl
    || post.thumbnailUrl
    || (post.mediaType !== "VIDEO" ? post.mediaUrl : null);
}

const extensoes = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png", "image/avif": "avif" };

async function baixar(url, idSeguro) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`foto respondeu ${res.status}`);
  const tipo = (res.headers.get("content-type") || "").split(";")[0].trim();
  const ext = extensoes[tipo];
  if (!ext) throw new Error(`tipo inesperado: ${tipo || "desconhecido"}`);
  const dados = Buffer.from(await res.arrayBuffer());
  if (dados.length > LIMITE_FOTO) throw new Error("foto grande demais");
  const caminho = `${PASTA}/ig-${idSeguro}.${ext}`;
  await writeFile(caminho, dados);
  return caminho;
}

const resposta = await fetch(FEED);
if (!resposta.ok) {
  console.error(`O feed do Behold respondeu ${resposta.status}. Nada foi alterado.`);
  process.exit(1);
}
const feed = await resposta.json();
const posts = (Array.isArray(feed) ? feed : feed.posts || [])
  .slice()
  .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));

const atuais = await lerAtuais();
// um post é reconhecido pelo id do Behold ou pelo código do link (/reel/XXXX/), para nunca duplicar
const chaves = l => [l.id, codigoDoLink(l.link)].filter(Boolean);
const conhecidos = new Map(atuais.flatMap(l => chaves(l).map(k => [k, l])));
const novos = [];
let melhoradas = 0;

for (const post of posts) {
  if (!post?.id) continue;
  if (ficaForaDaArara(post)) {
    console.log(`Pulei o post ${post.id}: a legenda tem #DeladanyAvisa.`);
    continue;
  }
  const url = urlDaFoto(post);
  const idSeguro = String(post.id).replace(/[^\w-]/g, "");
  const existente = conhecidos.get(post.id) || conhecidos.get(codigoDoLink(post.permalink));
  if (existente) {
    // look que já está na arara com foto antiga, pequena: troca pela versão grande do Behold
    if (url && !existente.img.includes("/ig-")) {
      try {
        existente.img = await baixar(url, idSeguro);
        existente.id = post.id;
        melhoradas++;
        console.log(`Foto melhorada: ${existente.nome}`);
      } catch (erro) {
        console.warn(`Não consegui melhorar a foto de ${existente.nome}: ${erro.message}`);
      }
    }
    continue;
  }
  if (!url) continue;
  try {
    const img = await baixar(url, idSeguro);
    novos.push({
      id: post.id,
      nome: nomeDaLegenda(post.prunedCaption ?? post.caption),
      img,
      link: post.permalink || "https://www.instagram.com/deladany_store/",
    });
    console.log(`Novo look: ${novos.at(-1).nome}`);
  } catch (erro) {
    console.warn(`Pulei o post ${post.id}: ${erro.message}`);
  }
}

if (novos.length === 0 && melhoradas === 0) {
  console.log("Nenhum post novo. A arara continua igual.");
  process.exit(0);
}

const lista = [...novos, ...atuais].slice(0, MAXIMO);

// Apaga as fotos que saíram da arara, para o site não crescer para sempre.
const emUso = new Set(lista.map(l => l.img.split("/").pop()));
for (const arq of await readdir(PASTA)) {
  if (/\.(jpe?g|webp|png|avif)$/i.test(arq) && !emUso.has(arq)) {
    await unlink(`${PASTA}/${arq}`);
    console.log(`Removi foto antiga: ${arq}`);
  }
}

const corpo = lista.map(l => "  " + JSON.stringify(l)).join(",\n");
await writeFile(
  ARQUIVO,
  "// Gerado automaticamente por scripts/atualizar-looks.mjs. Não edite à mão: o robô diário sobrescreve.\n" +
  `window.LOOKS = [\n${corpo}\n];\n`
);
console.log(`Arara atualizada: ${novos.length} novo(s), ${melhoradas} foto(s) melhorada(s), ${lista.length} no total.`);
