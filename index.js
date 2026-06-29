const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_TOKEN;
let checkTimer = null;
const SHEET_ID   = process.env.SHEET_ID;
const FACTORY    = process.env.FACTORY_NAME || "โรงงาน";

// คอลัมน์ใน Sheet (row เริ่ม 6)
const C = {
  NO:1, NAME:2, UNIT:3, STOCK:4,
  T1_LEVEL:5, T1_QTY:6,
  T2_LEVEL:7, T2_QTY:8,
  T3_LEVEL:9, T3_QTY:10,
  SUP_A:11, SUP_B:12,
  ROTATE:13, LAST_Q:14, STATUS:15, PREV_STOCK:16
};

async function getSheets() {
  let creds;
  const raw = process.env.GOOGLE_CREDENTIALS;
  if (!raw) throw new Error("GOOGLE_CREDENTIALS is not set");
  try { creds = JSON.parse(raw); }
  catch(e) {
    try { creds = JSON.parse(Buffer.from(raw,'base64').toString('utf8')); }
    catch(e2) { throw new Error("GOOGLE_CREDENTIALS invalid"); }
  }
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version:'v4', auth });
}

async function sendLine(groupId, message) {
  try {
    const res = await axios.post('https://api.line.me/v2/bot/message/push',
      { to: groupId, messages: [{ type:'text', text:message }] },
      { headers: { 'Authorization': `Bearer ${LINE_TOKEN}` } }
    );
    return res.status;
  } catch(e) {
    console.error('sendLine error:', e.response?.data || e.message);
    return 0;
  }
}

async function getFactoryGroupId(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range:'ตั้งค่า_Line_Bot!B3'
  });
  return (res.data.values||[['']])[0][0];
}

function getTier(stock, t1, t2, t3) {
  if (stock <= t3) return 3;
  if (stock <= t2) return 2;
  if (stock <= t1) return 1;
  return 0;
}

function getOrderQty(tier, t1qty, t2qty, t3qty) {
  if (tier === 3) return t3qty;
  if (tier === 2) return t2qty;
  if (tier === 1) return t1qty;
  return 0;
}

function getTierLabel(tier) {
  if (tier === 3) return '🔴 Tier 3 (หมด!)';
  if (tier === 2) return '🟠 Tier 2 (วิกฤต)';
  if (tier === 1) return '🟡 Tier 1 (เหลือน้อย)';
  return '✅ ปกติ';
}

async function savePrevStock(sheets, rowIndex, stock) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Stock_วัตถุดิบ!P${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[stock]] }
  });
}

async function updateStatus(sheets, rowIndex, queue, status) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Stock_วัตถุดิบ!N${rowIndex}:O${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[queue, status]] }
  });
}

async function logHistory(sheets, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'ประวัติ_สั่งซื้อ!A:H',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] }
  });
}

async function checkAllStock() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Stock_วัตถุดิบ!A6:P200',
  });

  const rows = res.data.values || [];
  const now = new Date().toLocaleString('th-TH', { timeZone:'Asia/Bangkok' });

  // ===== จัดกลุ่มตาม Supplier =====
  // Map: "supGroupId" → { supName, queue, items:[] }
  const supplierMap = {};

  for (let i = 0; i < rows.length; i++) {
    const row     = rows[i];
    const name    = row[C.NAME-1] || '';
    if (!name) continue;

    const unit    = row[C.UNIT-1] || '';
    const stock   = parseFloat(row[C.STOCK-1]) || 0;
    const t1l     = parseFloat(row[C.T1_LEVEL-1]) || 0;
    const t1q     = parseFloat(row[C.T1_QTY-1]) || 0;
    const t2l     = parseFloat(row[C.T2_LEVEL-1]) || 0;
    const t2q     = parseFloat(row[C.T2_QTY-1]) || 0;
    const t3l     = parseFloat(row[C.T3_LEVEL-1]) || 0;
    const t3q     = parseFloat(row[C.T3_QTY-1]) || 0;
    const supA    = row[C.SUP_A-1] || '';
    const supB    = row[C.SUP_B-1] || '';
    const rotate  = (row[C.ROTATE-1]||'NO').toUpperCase()==='YES';
    const lastQ   = (row[C.LAST_Q-1]||'B').toUpperCase();
    const status  = row[C.STATUS-1] || '';
    const actualRow = i + 6;

    const tier = getTier(stock, t1l, t2l, t3l);
    const prevStock = parseFloat(row[C.PREV_STOCK-1]) || 0;

    // รีเซ็ต ถ้า Stock เพิ่มขึ้นจากชั่วโมงก่อน = ของมาแล้ว
    if (status === '⏳ รอของ' && stock > prevStock) {
      await updateStatus(sheets, actualRow, lastQ, '✅ ปกติ');
      await savePrevStock(sheets, actualRow, stock);
      continue;
    }

    // บันทึก Stock ปัจจุบันไว้เปรียบเทียบชั่วโมงหน้า
    if (stock !== prevStock) {
      await savePrevStock(sheets, actualRow, stock);
    }

    // ข้ามถ้าปกติหรือรอของอยู่
    if (tier === 0 || status === '⏳ รอของ') continue;

    // เลือก Supplier
    let targetQueue = 'A';
    let targetSup   = supA;
    if (rotate && supB) {
      targetQueue = lastQ === 'A' ? 'B' : 'A';
      targetSup   = targetQueue === 'A' ? supA : supB;
    }
    if (!targetSup) continue;

    const parts      = targetSup.split('|');
    const supName    = parts[0].trim();
    const supGroupId = parts[1] ? parts[1].trim() : '';
    if (!supGroupId) continue;

    const orderQty = getOrderQty(tier, t1q, t2q, t3q);

    // เพิ่มเข้า supplierMap
    const key = `${supGroupId}__${targetQueue}`;
    if (!supplierMap[key]) {
      supplierMap[key] = { supName, supGroupId, targetQueue, items:[] };
    }
    supplierMap[key].items.push({ name, unit, stock, tier, orderQty, actualRow, lastQ: targetQueue });
  }

  // ===== ส่งรวมทีละ Supplier =====
  const factoryGroupId = await getFactoryGroupId(sheets);
  let totalOrdered = 0;

  for (const key of Object.keys(supplierMap)) {
    const { supName, supGroupId, targetQueue, items } = supplierMap[key];

    // Tier 2 ขึ้นไป = trigger ส่ง, Tier 1 = พ่วงอย่างเดียว
    const hasTrigger = items.some(it => it.tier >= 2);
    if (!hasTrigger) continue;

    // สร้างใบสั่งซื้อรวม
    let itemLines = '';
    items.forEach(it => {
      itemLines +=
        `\n▪️ ${it.name}\n` +
        `   สั่ง: ${it.orderQty} ${it.unit}\n` +
        `   Stock เหลือ: ${it.stock} ${it.unit}\n`;
    });

    const orderMsg =
      `📋 ใบสั่งซื้อวัตถุดิบ\n` +
      `🏭 ${FACTORY}\n` +
      `🕐 ${now}\n` +
      `${'─'.repeat(28)}\n` +
      `🏢 ${supName}\n` +
      `${'─'.repeat(28)}\n` +
      itemLines +
      `${'─'.repeat(28)}\n` +
      `กรุณายืนยันและแจ้งวันจัดส่งด้วยครับ/ค่ะ 🙏`;

    const code = await sendLine(supGroupId, orderMsg);
    if (code === 200) {
      // อัพเดทสถานะทุก item
      for (const it of items) {
        await updateStatus(sheets, it.actualRow, targetQueue, '⏳ รอของ');
      }

      // แจ้งกลุ่มโรงงาน
      if (factoryGroupId) {
        const summary = items.map(it=>`▪️ ${it.name} ${it.orderQty} ${it.unit} (${getTierLabel(it.tier)})`).join('\n');
        await sendLine(factoryGroupId,
          `🤖 Bot สั่งซื้อแล้ว\n🏢 ${supName} (คิว ${targetQueue})\n${'─'.repeat(24)}\n${summary}\n🕐 ${now}`
        );
      }

      // บันทึกประวัติ
      const itemSummary = items.map(it=>`${it.name} ${it.orderQty}${it.unit}`).join(', ');
      const triggerTier = Math.max(...items.map(it=>it.tier));
      await logHistory(sheets, [now, supName, itemSummary, getTierLabel(triggerTier), targetQueue, items.length, '✅ ส่งแล้ว', '']);

      totalOrdered += items.length;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  return { ordered: totalOrdered };
}

// Routes
app.get('/', (req,res) => res.json({ status:'Stock Bot running ✅' }));

app.get('/debug', (req,res) => res.json({
  LINE_TOKEN: LINE_TOKEN ? `✅ (${LINE_TOKEN.length} chars)` : '❌ missing',
  SHEET_ID: SHEET_ID ? `✅ ${SHEET_ID}` : '❌ missing',
  GOOGLE_CREDENTIALS: process.env.GOOGLE_CREDENTIALS ? `✅ (${process.env.GOOGLE_CREDENTIALS.length} chars)` : '❌ missing',
  FACTORY_NAME: FACTORY,
}));

app.post('/webhook', async (req,res) => {
  res.status(200).json({ status:'ok' });
  try {
    const events = req.body.events || [];
    for (const event of events) {
      if (event.source?.type === 'group') {
        const groupId = event.source.groupId;
        const text = event.message?.text || '';
        if (text.toLowerCase().includes('group id')) {
          await sendLine(groupId, `📋 Group ID ของกลุ่มนี้:\n${groupId}\n\nคัดลอกไปวางใน Sheet ได้เลยครับ`);
        }
      }
    }
  } catch(e) { console.error(e); }
});

app.get('/check', async (req,res) => {
  try {
    const result = await checkAllStock();
    res.json({ status:'ok', ...result });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Stock Bot v3 running on port ${PORT}`));


// ============================================================
//  หน้ากรอก Stock บน Tablet — กรอกครบแล้วกดบันทึกทีเดียว
// ============================================================
app.get('/stock', async (req, res) => {
  try {
    const sheets = await getSheets();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Stock_วัตถุดิบ!B6:D200',
    });
    const rows = (result.data.values || []).filter(r => r[0]);
    const items = rows.map(r => ({ name: r[0], unit: r[2] || '' }));
    const itemsJson = JSON.stringify(items);

    res.send(`<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>กรอก Stock</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:sans-serif;background:#f0f2f5;padding:16px 12px}
h1{font-size:22px;font-weight:700;color:#1E3A5F;margin-bottom:2px}
.date{font-size:13px;color:#888;margin-bottom:20px}
.item{background:#fff;border-radius:12px;padding:14px 16px;margin-bottom:10px;display:flex;align-items:center;gap:12px;border:1.5px solid #eee}
.item.missing{border-color:#E24B4A}
.num{width:30px;height:30px;border-radius:50%;background:#f0f2f5;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#888;flex-shrink:0}
.name{flex:1}
.name p{font-size:15px;font-weight:600;color:#222;margin-bottom:1px}
.name small{font-size:12px;color:#aaa}
input{width:90px;padding:10px 8px;font-size:18px;font-weight:700;border:1.5px solid #ddd;border-radius:10px;text-align:center;color:#1E3A5F;background:#f8f9ff}
input:focus{outline:none;border-color:#185FA5}
.btn-wrap{position:sticky;bottom:0;background:#f0f2f5;padding:12px 0 4px}
.btn{width:100%;padding:18px;font-size:17px;font-weight:700;background:#185FA5;color:#fff;border:none;border-radius:14px;cursor:pointer}
.btn:active{opacity:0.85}
.btn:disabled{background:#aaa}
.err-msg{color:#E24B4A;font-size:13px;text-align:center;margin-bottom:8px;display:none}
.ok{background:#EAF3DE;border-radius:14px;padding:24px;text-align:center;margin-top:16px;display:none}
.ok p{font-size:18px;font-weight:700;color:#3B6D11}
.ok small{font-size:13px;color:#639922}
.loading{text-align:center;padding:12px;font-size:14px;color:#888;display:none}
</style>
</head>
<body>
<h1>กรอก Stock วันนี้</h1>
<div class="date" id="dt"></div>
<div id="list"></div>
<div class="err-msg" id="errmsg">กรุณากรอกให้ครบทุกช่อง</div>
<div class="btn-wrap">
  <div class="loading" id="loading">กำลังบันทึก...</div>
  <button class="btn" id="btn" onclick="submitAll()">บันทึก Stock ทั้งหมด</button>
</div>
<div class="ok" id="ok">
  <p>บันทึกสำเร็จแล้ว!</p>
  <small id="ok-detail"></small>
</div>
<script>
const items = ${itemsJson};
document.getElementById('dt').textContent = new Date().toLocaleDateString('th-TH',{weekday:'long',year:'numeric',month:'long',day:'numeric'});

const list = document.getElementById('list');
items.forEach((it,i) => {
  const div = document.createElement('div');
  div.className = 'item';
  div.id = 'row'+i;
  div.innerHTML = '<div class="num">'+(i+1)+'</div><div class="name"><p>'+it.name+'</p><small>หน่วย: '+it.unit+'</small></div><input type="number" inputmode="decimal" id="inp'+i+'" placeholder="0" min="0" oninput="clearErr('+i+')">';
  list.appendChild(div);
});

function clearErr(i){
  document.getElementById('row'+i).classList.remove('missing');
  document.getElementById('errmsg').style.display='none';
}

async function submitAll(){
  let missing = false;
  const body = items.map((it,i) => {
    const v = document.getElementById('inp'+i).value.trim();
    if(!v || isNaN(v)){
      document.getElementById('row'+i).classList.add('missing');
      missing = true;
      return null;
    }
    return {name:it.name, unit:it.unit, stock:parseFloat(v)};
  });

  if(missing){
    document.getElementById('errmsg').style.display='block';
    document.querySelector('.missing input').focus();
    document.querySelector('.missing').scrollIntoView({behavior:'smooth',block:'center'});
    return;
  }

  document.getElementById('btn').disabled = true;
  document.getElementById('loading').style.display='block';

  const res = await fetch('/stock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  document.getElementById('loading').style.display='none';
  if(res.ok){
    document.getElementById('btn').style.display='none';
    document.getElementById('ok').style.display='block';
    document.getElementById('ok-detail').textContent = 'บันทึก '+items.length+' รายการ เวลา '+new Date().toLocaleTimeString('th-TH');
  } else {
    document.getElementById('btn').disabled=false;
    alert('เกิดข้อผิดพลาด กรุณาลองใหม่');
  }
}
</script>
</body>
</html>`);
  } catch(e) {
    res.status(500).send('เกิดข้อผิดพลาด: ' + e.message);
  }
});

// รับข้อมูลจากฟอร์ม tablet อัพเดท Sheet
app.post('/stock', async (req, res) => {
  try {
    const sheets = await getSheets();
    const items = req.body;
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Stock_วัตถุดิบ!B6:B200',
    });
    const names = (result.data.values || []).map(r => r[0]);
    for (const item of items) {
      const idx = names.findIndex(n => n === item.name);
      if (idx >= 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `Stock_วัตถุดิบ!D${idx + 6}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[item.stock]] }
        });
      }
    }
    res.json({ status: 'ok' });
    if (checkTimer) {
      clearTimeout(checkTimer);
      console.log('Previous check cancelled, resetting 30min timer...');
    }
    checkTimer = setTimeout(async () => {
      checkTimer = null;
      try {
        console.log('Running stock check 30 min after form submit...');
        await checkAllStock();
      } catch(e) { console.error('Delayed check error:', e.message); }
    }, 30 * 60 * 1000);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
