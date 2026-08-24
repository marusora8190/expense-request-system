// 予想経費申請書システム - 古いデータの自動整理スクリプト
// 毎月1回、GitHub Actionsから実行される想定。
//
// ・作成日からまる7年経過 → 添付PDFファイルだけを削除(申請データは残す)
// ・作成日からまる10年経過 → 申請データ本体を削除(アーカイブは取らない)
//
// 実行に必要な環境変数:
//   SUPABASE_URL      例) https://xxxx.supabase.co
//   SUPABASE_KEY      anonキー(expense_form.html に埋め込まれているものと同じ)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PDF_BUCKET = 'expense-pdfs';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_KEY が設定されていません。GitHubのSecretsを確認してください。');
  process.exit(1);
}

function isoDateYearsAgo(years) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase API エラー (${res.status}) ${path}: ${text}`);
  }
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function deletePdfObjectByUrl(url) {
  if (!url) return;
  const marker = `/storage/v1/object/public/${PDF_BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return;
  const path = url.slice(idx + marker.length);
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${PDF_BUCKET}/${path}`, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`PDF削除に失敗しました: ${path} (${res.status}) ${text}`);
  }
}

// -------- ① 7年経過: 添付PDFだけを削除 --------
async function cleanupOldPdfs() {
  const cutoff = isoDateYearsAgo(7);
  console.log(`[PDF削除] 作成日が ${cutoff} 以前で、PDFが添付されている申請を検索します…`);

  const rows = await sb(
    `expense_requests?select=id,pdf_no,pdf_url&pdf_url=not.is.null&created_at=lte.${cutoff}`
  );

  if (!rows || rows.length === 0) {
    console.log('[PDF削除] 対象はありませんでした。');
    return;
  }

  console.log(`[PDF削除] ${rows.length} 件が対象です。`);
  for (const r of rows) {
    await deletePdfObjectByUrl(r.pdf_url);
    await sb(`expense_requests?id=eq.${r.id}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ pdf_url: null, has_estimate_attached: false }),
    });
    console.log(`  - 削除済み: PDF No.${r.pdf_no || '(なし)'} (id=${r.id})`);
  }
}

// -------- ② 10年経過: 申請データ本体を削除(アーカイブは取らない) --------
async function deleteOldRows() {
  const cutoff = isoDateYearsAgo(10);
  console.log(`[データ削除] 作成日が ${cutoff} 以前の申請を検索します…`);

  const rows = await sb(`expense_requests?select=id&created_at=lte.${cutoff}&order=created_at.asc`);

  if (!rows || rows.length === 0) {
    console.log('[データ削除] 対象はありませんでした。');
    return;
  }

  console.log(`[データ削除] ${rows.length} 件が対象です。削除します…`);

  const idList = rows.map((r) => r.id).join(',');
  await sb(`expense_requests?id=in.(${idList})`, {
    method: 'DELETE',
    prefer: 'return=minimal',
  });
  console.log(`[データ削除] ${rows.length} 件のデータ本体を削除しました。`);
}

async function main() {
  console.log(`=== 予想経費申請書 自動整理 開始 (${new Date().toISOString()}) ===`);
  try {
    await cleanupOldPdfs();
    await deleteOldRows();
    console.log('=== 完了 ===');
  } catch (e) {
    console.error('エラーが発生しました:', e);
    process.exit(1);
  }
}

main();
