// ========================================================
// Ice Cream Batch Tracker - Application Logic
// Tech Stack: Vanilla JS + Supabase JS SDK / LocalStorage Fallback
// ========================================================

const STORAGE_KEYS = {
  SUPABASE_URL: 'batch_tracker_sb_url',
  SUPABASE_KEY: 'batch_tracker_sb_key',
  STORAGE_MODE: 'batch_tracker_mode',
  LOCAL_LOTS: 'batch_tracker_local_lots',
  LOCAL_SALES: 'batch_tracker_local_sales',
  LOCAL_PRODUCTS: 'batch_tracker_local_products',
  LOCAL_ORDER_DRAFT: 'batch_tracker_order_draft',
  LOCAL_PO_META: 'batch_tracker_po_meta',
};

// Project Default Supabase Cloud Configuration (Auto-configured)
const DEFAULT_SUPABASE = {
  URL: 'https://xsrxmjwezrbwpinhaenz.supabase.co',
  KEY: 'sb_publishable_93zfEdNFZFQsoz_kD-ulag_NtEi_u2_'
};

// Application State
let supabaseClient = null;
let isOfflineMode = false;
let activeLot = null;
let currentLotSales = [];
let closedLots = [];
let currentInputAmount = '';
let selectedShift = 'lunch'; // 'lunch' | 'afternoon'
let currentReportScope = 'active'; // 'active' | 'all' | lotId
let productCatalog = [];
let orderDraftQuantities = {}; // { [productId]: boxQuantity }
let currentProductCategory = 'all';

// ========================================================
// 1. App Initialization & Supabase Client Setup
// ========================================================
document.addEventListener('DOMContentLoaded', async () => {
  initNumpadKeyboardSupport();
  await setupDatabaseClient();
  await loadActiveLotData();
  await loadProductCatalog();
});

async function setupDatabaseClient() {
  const preferredMode = localStorage.getItem(STORAGE_KEYS.STORAGE_MODE);
  
  // If user explicitly chose local mode in settings, remain offline
  if (preferredMode === 'local') {
    enableLocalMode();
    return;
  }

  const sbUrl = localStorage.getItem(STORAGE_KEYS.SUPABASE_URL) || DEFAULT_SUPABASE.URL;
  const sbKey = localStorage.getItem(STORAGE_KEYS.SUPABASE_KEY) || DEFAULT_SUPABASE.KEY;

  const statusBadge = document.getElementById('db-status-badge');
  const statusDot = document.getElementById('db-status-dot');
  const statusText = document.getElementById('db-status-text');

  if (sbUrl && sbKey && window.supabase) {
    try {
      supabaseClient = window.supabase.createClient(sbUrl, sbKey);
      // Quick ping test
      const { data, error } = await supabaseClient.from('lots').select('id').limit(1);
      if (error) throw error;

      isOfflineMode = false;
      statusDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0';
      statusText.innerText = 'ออนไลน์';
      statusBadge.className = 'flex items-center space-x-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/15 hover:bg-white/25 text-white border border-white/25 whitespace-nowrap shrink-0 cursor-pointer shadow-sm';
      return;
    } catch (err) {
      console.warn('Supabase connect failed, falling back to local mode:', err);
    }
  }

  enableLocalMode();
}

function enableLocalMode() {
  isOfflineMode = true;
  supabaseClient = null;
  const statusBadge = document.getElementById('db-status-badge');
  const statusDot = document.getElementById('db-status-dot');
  const statusText = document.getElementById('db-status-text');
  if (statusDot) statusDot.className = 'w-2 h-2 rounded-full bg-amber-300 shrink-0';
  if (statusText) statusText.innerText = 'ในเครื่อง';
  if (statusBadge) statusBadge.className = 'flex items-center space-x-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-amber-500/25 text-amber-100 border border-amber-300/40 whitespace-nowrap shrink-0 cursor-pointer shadow-sm';
  ensureLocalInitialData();
}

function ensureLocalInitialData() {
  let localLots = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOTS) || '[]');
  if (localLots.length === 0) {
    const initialLot = {
      id: generateUUID(),
      cost: 5000,
      float_money: 500,
      total_collected: 0,
      status: 'active',
      created_at: new Date().toISOString(),
      closed_at: null
    };
    localLots = [initialLot];
    localStorage.setItem(STORAGE_KEYS.LOCAL_LOTS, JSON.stringify(localLots));
  }
}

// ========================================================
// 2. Data Operations (Supabase / LocalStorage Abstraction)
// ========================================================
async function fetchActiveLot() {
  if (!isOfflineMode && supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from('lots')
        .select('*')
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1);

      if (error) throw error;

      if (data && data.length > 0) {
        return data[0];
      } else {
        // Auto-create initial active lot if none exists
        const newLot = {
          cost: 5000,
          float_money: 500,
          total_collected: 0,
          status: 'active'
        };
        const { data: created, error: createErr } = await supabaseClient
          .from('lots')
          .insert([newLot])
          .select()
          .single();
        if (createErr) throw createErr;
        return created;
      }
    } catch (e) {
      console.error('Error fetching active lot from Supabase:', e);
      showToast('ไม่สามารถเชื่อมต่อ Supabase ได้ สลับไปโหมดในเครื่องชั่วคราว', 'warning');
      isOfflineMode = true;
    }
  }

  // LocalStorage Fallback
  const localLots = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOTS) || '[]');
  let active = localLots.find(l => l.status === 'active');
  if (!active) {
    active = {
      id: generateUUID(),
      cost: 5000,
      float_money: 500,
      total_collected: 0,
      status: 'active',
      created_at: new Date().toISOString(),
      closed_at: null
    };
    localLots.unshift(active);
    localStorage.setItem(STORAGE_KEYS.LOCAL_LOTS, JSON.stringify(localLots));
  }
  if (active.float_money === undefined) active.float_money = 500;
  return active;
}

async function fetchSalesForLot(lotId) {
  if (!lotId) return [];

  if (!isOfflineMode && supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from('daily_sales')
        .select('*')
        .eq('lot_id', lotId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data || [];
    } catch (e) {
      console.error('Error fetching sales from Supabase:', e);
    }
  }

  // LocalStorage Fallback
  const allSales = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_SALES) || '[]');
  return allSales
    .filter(s => s.lot_id === lotId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function insertDailySale(lotId, amount, shift = 'lunch', note = '', floatDeducted = 0) {
  const newSale = {
    id: generateUUID(),
    lot_id: lotId,
    amount: parseFloat(amount),
    shift: shift || 'lunch',
    note: note || '',
    float_deducted: parseFloat(floatDeducted) || 0,
    created_at: new Date().toISOString()
  };

  const newTotal = parseFloat(activeLot.total_collected || 0) + parseFloat(amount);

  if (!isOfflineMode && supabaseClient) {
    try {
      // 1. Insert daily sale (with graceful fallback if extended columns aren't migrated yet)
      let { error: saleErr } = await supabaseClient
        .from('daily_sales')
        .insert([{
          lot_id: lotId,
          amount: parseFloat(amount),
          shift: shift || 'lunch',
          note: note || '',
          float_deducted: parseFloat(floatDeducted) || 0
        }]);

      if (saleErr) {
        // Fallback to minimal columns if user hasn't run ALTER TABLE yet
        const { error: fallbackErr } = await supabaseClient
          .from('daily_sales')
          .insert([{ lot_id: lotId, amount: parseFloat(amount) }]);
        if (fallbackErr) throw fallbackErr;
      }

      // 2. Update active lot total_collected
      const { error: lotErr } = await supabaseClient
        .from('lots')
        .update({ total_collected: newTotal })
        .eq('id', lotId);
      if (lotErr) throw lotErr;

      return true;
    } catch (err) {
      console.error('Supabase write error:', err);
      showToast('เกิดข้อผิดพลาดในการบันทึกลง Supabase กำลังบันทึกในเครื่องแทน', 'warning');
      isOfflineMode = true;
    }
  }

  // LocalStorage Fallback
  const allSales = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_SALES) || '[]');
  allSales.unshift(newSale);
  localStorage.setItem(STORAGE_KEYS.LOCAL_SALES, JSON.stringify(allSales));

  const localLots = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOTS) || '[]');
  const lotIdx = localLots.findIndex(l => l.id === lotId);
  if (lotIdx !== -1) {
    localLots[lotIdx].total_collected = newTotal;
    localStorage.setItem(STORAGE_KEYS.LOCAL_LOTS, JSON.stringify(localLots));
  }

  return true;
}

async function updateLotCostAndFloatDB(lotId, newCost, newFloat) {
  if (!isOfflineMode && supabaseClient) {
    try {
      let { error } = await supabaseClient
        .from('lots')
        .update({ cost: parseFloat(newCost), float_money: parseFloat(newFloat) })
        .eq('id', lotId);
      if (error) {
        // Fallback if float_money column not yet migrated
        const { error: err2 } = await supabaseClient
          .from('lots')
          .update({ cost: parseFloat(newCost) })
          .eq('id', lotId);
        if (err2) throw err2;
      }
      return true;
    } catch (e) {
      console.error('Error updating cost in Supabase:', e);
    }
  }

  const localLots = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOTS) || '[]');
  const idx = localLots.findIndex(l => l.id === lotId);
  if (idx !== -1) {
    localLots[idx].cost = parseFloat(newCost);
    localLots[idx].float_money = parseFloat(newFloat);
    localStorage.setItem(STORAGE_KEYS.LOCAL_LOTS, JSON.stringify(localLots));
  }
  return true;
}

async function updateDailySaleDB(saleId, lotId, newAmount, newShift, newNote) {
  if (!isOfflineMode && supabaseClient) {
    try {
      let { error } = await supabaseClient
        .from('daily_sales')
        .update({
          amount: parseFloat(newAmount),
          shift: newShift,
          note: newNote
        })
        .eq('id', saleId);

      if (error) {
        const { error: err2 } = await supabaseClient
          .from('daily_sales')
          .update({ amount: parseFloat(newAmount) })
          .eq('id', saleId);
        if (err2) throw err2;
      }

      // Recalculate total_collected for the lot
      const sales = await fetchSalesForLot(lotId);
      const recalculatedTotal = sales.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);
      await supabaseClient.from('lots').update({ total_collected: recalculatedTotal }).eq('id', lotId);
      return true;
    } catch (e) {
      console.error('Error updating sale in Supabase:', e);
    }
  }

  // LocalStorage
  const allSales = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_SALES) || '[]');
  const sIdx = allSales.findIndex(s => s.id === saleId);
  if (sIdx !== -1) {
    allSales[sIdx].amount = parseFloat(newAmount);
    allSales[sIdx].shift = newShift;
    allSales[sIdx].note = newNote;
    localStorage.setItem(STORAGE_KEYS.LOCAL_SALES, JSON.stringify(allSales));
  }

  const lotSales = allSales.filter(s => s.lot_id === lotId);
  const newTotal = lotSales.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);

  const localLots = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOTS) || '[]');
  const lIdx = localLots.findIndex(l => l.id === lotId);
  if (lIdx !== -1) {
    localLots[lIdx].total_collected = newTotal;
    localStorage.setItem(STORAGE_KEYS.LOCAL_LOTS, JSON.stringify(localLots));
  }
  return true;
}

async function deleteDailySaleDB(saleId, lotId) {
  if (!isOfflineMode && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from('daily_sales')
        .delete()
        .eq('id', saleId);
      if (error) throw error;

      const sales = await fetchSalesForLot(lotId);
      const recalculatedTotal = sales.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);
      await supabaseClient.from('lots').update({ total_collected: recalculatedTotal }).eq('id', lotId);
      return true;
    } catch (e) {
      console.error('Error deleting sale in Supabase:', e);
    }
  }

  // LocalStorage
  let allSales = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_SALES) || '[]');
  allSales = allSales.filter(s => s.id !== saleId);
  localStorage.setItem(STORAGE_KEYS.LOCAL_SALES, JSON.stringify(allSales));

  const lotSales = allSales.filter(s => s.lot_id === lotId);
  const newTotal = lotSales.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);

  const localLots = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOTS) || '[]');
  const lIdx = localLots.findIndex(l => l.id === lotId);
  if (lIdx !== -1) {
    localLots[lIdx].total_collected = newTotal;
    localStorage.setItem(STORAGE_KEYS.LOCAL_LOTS, JSON.stringify(localLots));
  }
  return true;
}

async function closeActiveLotAndStartNew(currentLotId) {
  const nowIso = new Date().toISOString();
  const prevFloat = activeLot && activeLot.float_money !== undefined ? parseFloat(activeLot.float_money) : 500;
  const prevCost = activeLot && activeLot.cost !== undefined ? parseFloat(activeLot.cost) : 5000;

  if (!isOfflineMode && supabaseClient) {
    try {
      // 1. Update current lot to closed
      const { error: closeErr } = await supabaseClient
        .from('lots')
        .update({
          status: 'closed',
          closed_at: nowIso
        })
        .eq('id', currentLotId);
      if (closeErr) throw closeErr;

      // 2. Create brand new active lot
      let { data: newLot, error: newErr } = await supabaseClient
        .from('lots')
        .insert([{
          cost: prevCost,
          float_money: prevFloat,
          total_collected: 0,
          status: 'active'
        }])
        .select()
        .single();

      if (newErr) {
        const { data: fallbackLot, error: err2 } = await supabaseClient
          .from('lots')
          .insert([{ cost: prevCost, total_collected: 0, status: 'active' }])
          .select()
          .single();
        if (err2) throw err2;
        newLot = fallbackLot;
      }

      return newLot;
    } catch (e) {
      console.error('Error closing lot in Supabase:', e);
      showToast('เกิดข้อผิดพลาดในการปิดลอตใน Supabase', 'error');
      return null;
    }
  }

  // LocalStorage Fallback
  const localLots = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOTS) || '[]');
  const idx = localLots.findIndex(l => l.id === currentLotId);
  if (idx !== -1) {
    localLots[idx].status = 'closed';
    localLots[idx].closed_at = nowIso;
  }

  const newLot = {
    id: generateUUID(),
    cost: prevCost,
    float_money: prevFloat,
    total_collected: 0,
    status: 'active',
    created_at: nowIso,
    closed_at: null
  };
  localLots.unshift(newLot);
  localStorage.setItem(STORAGE_KEYS.LOCAL_LOTS, JSON.stringify(localLots));
  return newLot;
}

async function fetchClosedLotsWithDetails() {
  if (!isOfflineMode && supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from('lots')
        .select('*')
        .eq('status', 'closed')
        .order('closed_at', { ascending: false });

      if (error) throw error;
      return data || [];
    } catch (e) {
      console.error('Error fetching closed lots:', e);
    }
  }

  // LocalStorage Fallback
  const localLots = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOTS) || '[]');
  return localLots
    .filter(l => l.status === 'closed')
    .sort((a, b) => new Date(b.closed_at || b.created_at) - new Date(a.closed_at || a.created_at));
}

// ========================================================
// 3. UI Rendering & Business Logic (Sections 1, 2, 3)
// ========================================================

// --- SECTION 1: DASHBOARD & ANALYTICS ---
async function loadActiveLotData() {
  activeLot = await fetchActiveLot();
  if (!activeLot) return;

  currentLotSales = await fetchSalesForLot(activeLot.id);
  closedLots = await fetchClosedLotsWithDetails();
  renderDashboardUI();
  renderAnalyticsUI();
}

function renderDashboardUI() {
  if (!activeLot) return;

  const cost = parseFloat(activeLot.cost) || 5000;
  const floatMoney = activeLot.float_money !== undefined ? parseFloat(activeLot.float_money) : 500;
  const collected = parseFloat(activeLot.total_collected) || 0;
  const diff = collected - cost;
  const percentage = cost > 0 ? (collected / cost) * 100 : 0;

  // Header & Meta (แสดง "ลอตที่ 1", "ลอตที่ 2" เข้าใจง่าย แทนรหัสเทคนิคยาวๆ)
  const lotNum = (closedLots && closedLots.length > 0) ? closedLots.length + 1 : 1;
  const lotLabel = `ลอตที่ ${lotNum}`;
  const elActiveLotId = document.getElementById('active-lot-id');
  const elInputTargetLot = document.getElementById('input-target-lot');
  if (elActiveLotId) elActiveLotId.innerText = lotLabel;
  if (elInputTargetLot) elInputTargetLot.innerText = lotLabel;
  
  const createdDate = new Date(activeLot.created_at);
  document.getElementById('active-lot-date').innerText = `เปิดลอต: ${createdDate.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })}`;

  // Metric Boxes
  document.getElementById('dash-cost').innerText = `฿${cost.toLocaleString('th-TH')}`;
  const floatEl = document.getElementById('dash-float-money');
  if (floatEl) floatEl.innerText = `฿${floatMoney.toLocaleString('th-TH')}`;
  const inputFloatBadge = document.getElementById('input-float-badge');
  if (inputFloatBadge) inputFloatBadge.innerText = `เงินทอน: ฿${floatMoney.toLocaleString('th-TH')}`;

  document.getElementById('dash-collected').innerText = `฿${collected.toLocaleString('th-TH')}`;
  document.getElementById('dash-sales-count').innerText = `${currentLotSales.length} รายการที่บันทึกแล้ว`;

  // Progress Bar
  const displayProgressWidth = Math.min(100, Math.max(0, percentage));
  const progressBar = document.getElementById('dash-progress-bar');
  const progressPercent = document.getElementById('dash-progress-percent');
  const remainingLabel = document.getElementById('dash-remaining-label');

  progressPercent.innerText = `${percentage.toFixed(1)}%`;
  progressBar.style.width = `${displayProgressWidth}%`;

  // --- COLOR-CODED ALERTS (ปรับตามสัดส่วนของต้นทุนตั้งต้น เช่น 80% = 4,000 จาก 5,000) ---
  const warningThreshold = Math.round(cost * 0.8); // 4,000 when cost is 5,000
  const alertBox = document.getElementById('dash-status-alert');
  const alertIcon = document.getElementById('dash-alert-icon');
  const alertTitle = document.getElementById('dash-alert-title');
  const alertDesc = document.getElementById('dash-alert-desc');

  if (collected <= warningThreshold) {
    // ระดับ 1: 0 - 80% ของต้นทุน (แถบสีฟ้าไอเย็นตู้แช่วอลล์ / ปกติ)
    progressBar.className = 'h-full rounded-full transition-all duration-700 ease-out bg-gradient-to-r from-sky-400 via-cyan-500 to-blue-500 freezer-bar-shimmer';
    remainingLabel.innerText = `❄️ ยังขาดอีก ฿${(cost - collected).toLocaleString('th-TH')} จะคืนทุน`;
    
    alertBox.className = 'p-4 rounded-2xl flex items-start space-x-3.5 transition-all duration-300 bg-sky-50 border border-sky-200 text-sky-900';
    alertIcon.innerHTML = '<i class="fa-solid fa-snowflake text-sky-500 text-xl"></i>';
    alertTitle.innerText = '❄️ สถานะตู้แช่วอลล์: ไอศกรีมเต็มตู้พร้อมขาย!';
    alertDesc.innerText = `เก็บยอดได้ ฿${collected.toLocaleString('th-TH')} (เป้าคืนทุน ฿${cost.toLocaleString('th-TH')}) ไอศกรีมในตู้แช่ยังมีเพียงพอสำหรับเด็ก ๆ`;

  } else if (collected > warningThreshold && collected <= cost) {
    // ระดับ 2: 80% - 100% ของต้นทุน (แถบสีเหลืองส้ม / กระดิ่งรถวอลล์เตือนใกล้หมดตู้)
    progressBar.className = 'h-full rounded-full transition-all duration-700 ease-out bg-gradient-to-r from-amber-400 via-orange-500 to-rose-500 freezer-bar-shimmer';
    remainingLabel.innerText = `🔔 ใกล้คืนทุนแล้ว! ขาดอีกเพียง ฿${(cost - collected).toLocaleString('th-TH')}`;

    alertBox.className = 'p-4 rounded-2xl flex items-start space-x-3.5 transition-all duration-300 bg-amber-50 border-2 border-amber-300 text-amber-950 shadow-sm';
    alertIcon.innerHTML = '<i class="fa-solid fa-bell text-amber-600 text-xl walls-bell-anim"></i>';
    alertTitle.innerText = '🔔 ไอติมใกล้เกลี้ยงตู้แล้ว! เตรียมสั่งเซลล์วอลล์ลอตใหม่!';
    alertDesc.innerText = `ยอดสะสมแตะ ฿${collected.toLocaleString('th-TH')} แล้ว กดไปที่แท็บ "สินค้า & ใบสั่งซื้อ" เพื่อออกใบสั่งซื้อ PDF ส่งร้านค้าได้เลย`;

  } else {
    // ระดับ 3: > ต้นทุน (แถบสีเขียวมรกต / คืนทุนแล้ว กำไรล้วน ๆ)
    progressBar.className = 'h-full rounded-full transition-all duration-700 ease-out bg-gradient-to-r from-emerald-400 via-teal-500 to-green-600 shadow-sm freezer-bar-shimmer';
    remainingLabel.innerHTML = `<span class="text-emerald-600 font-bold">❤️ คืนทุนครบ 100% แล้ว!</span>`;

    alertBox.className = 'p-4 rounded-2xl flex items-start space-x-3.5 transition-all duration-300 bg-emerald-50 border-2 border-emerald-300 text-emerald-950 shadow-sm';
    alertIcon.innerHTML = '<i class="fa-solid fa-heart text-[#E4002B] text-xl animate-bounce"></i>';
    alertTitle.innerText = `🎉 คืนทุนแล้ว! กำไรสุทธิปัจจุบัน: +฿${diff.toLocaleString('th-TH')} บาท`;
    alertDesc.innerText = `ทะลุทุน ฿${cost.toLocaleString('th-TH')} เรียบร้อย! ทุกแท่งที่ขายได้ตอนนี้คือกำไรล้วน ๆ ของโครงการโรงเรียน`;
  }

  // Render Recent Sales List in Current Lot
  renderCurrentLotSalesList();
}

function renderCurrentLotSalesList() {
  const container = document.getElementById('dash-sales-list');
  const countBadge = document.getElementById('dash-recent-count');
  countBadge.innerText = `${currentLotSales.length} รายการ`;

  if (currentLotSales.length === 0) {
    container.innerHTML = `
      <div class="text-center py-10 text-xs text-slate-400">
        <i class="fa-solid fa-receipt text-3xl text-slate-300 mb-2 block"></i>
        ยังไม่มีการบันทึกยอดเงินในลอตนี้<br>กดปุ่ม "บันทึกยอดเงินสดวันนี้" เพื่อเริ่มต้น
      </div>
    `;
    return;
  }

  container.innerHTML = currentLotSales.map((sale, idx) => {
    const saleDate = new Date(sale.created_at);
    const dateFormatted = saleDate.toLocaleDateString('th-TH', { 
      day: 'numeric', 
      month: 'short' 
    });
    const timeFormatted = saleDate.toLocaleTimeString('th-TH', { 
      hour: '2-digit', 
      minute: '2-digit' 
    });

    const isNoSale = parseFloat(sale.amount) === 0;
    const isAfternoon = sale.shift === 'afternoon';
    const shiftBadge = isNoSale
      ? '<span class="px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 text-[10px] font-bold">⛔ งดขายวันนี้</span>'
      : isAfternoon
        ? '<span class="px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 text-[10px] font-bold">🌤️ พักบ่าย</span>'
        : '<span class="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-bold">☀️ พักเที่ยง</span>';

    const noteHtml = sale.note
      ? `<p class="text-[11px] ${isNoSale ? 'text-rose-600 font-semibold' : 'text-slate-500'} mt-0.5"><i class="fa-regular fa-comment-dots ${isNoSale ? 'text-rose-400' : 'text-slate-400'} mr-1"></i>${escapeHtml(sale.note)}</p>`
      : '';

    const amountBadge = isNoSale
      ? '<span class="font-bold text-xs px-2 py-0.5 rounded-full bg-rose-50 text-rose-600 border border-rose-200">งดขาย (฿0)</span>'
      : `<span class="font-extrabold text-sm text-slate-900 font-mono">+฿${parseFloat(sale.amount).toLocaleString('th-TH')}</span>`;

    return `
      <div class="py-3 first:pt-1 flex items-start justify-between gap-2 text-xs group">
        <div class="flex items-start space-x-2.5 min-w-0">
          <div class="w-7 h-7 rounded-lg ${isNoSale ? 'bg-rose-50 text-rose-500' : 'bg-slate-100 text-slate-500'} flex items-center justify-center text-[11px] font-bold shrink-0 mt-0.5">
            ${currentLotSales.length - idx}
          </div>
          <div class="min-w-0">
            <div class="flex items-center flex-wrap gap-1.5">
              ${shiftBadge}
              <span class="text-[11px] text-slate-400">${dateFormatted} • ${timeFormatted} น.</span>
            </div>
            ${noteHtml}
          </div>
        </div>
        <div class="flex items-center space-x-2 shrink-0">
          ${amountBadge}
          <button onclick="openEditSaleModal('${sale.id}')" class="w-7 h-7 rounded-lg bg-slate-100 hover:bg-blue-50 text-slate-400 hover:text-blue-600 flex items-center justify-center transition" title="แก้ไขหรือลบรายการนี้">
            <i class="fa-solid fa-pen text-[10px]"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// --- ANALYTICS & DAILY TREND CHART ---
function renderAnalyticsUI() {
  const avgDaysEl = document.getElementById('stat-avg-days-per-lot');
  const avgDaysSubEl = document.getElementById('stat-avg-days-sub');
  const avgDailySaleEl = document.getElementById('stat-avg-daily-sale');
  const estDaysLeftEl = document.getElementById('stat-est-days-left');
  const lunchTotalEl = document.getElementById('stat-lunch-total');
  const lunchPctEl = document.getElementById('stat-lunch-pct');
  const afternoonTotalEl = document.getElementById('stat-afternoon-total');
  const afternoonPctEl = document.getElementById('stat-afternoon-pct');
  const chartContainer = document.getElementById('daily-trend-chart');

  if (!avgDaysEl || !activeLot) return;

  // 1. Calculate Average Days per Closed Lot (or Active Lot elapsed days)
  let totalDays = 0;
  let countedLots = 0;

  closedLots.forEach(lot => {
    if (lot.created_at && lot.closed_at) {
      const start = new Date(lot.created_at);
      const end = new Date(lot.closed_at);
      const diffDays = Math.max(1, (end - start) / (1000 * 60 * 60 * 24));
      totalDays += diffDays;
      countedLots++;
    }
  });

  if (countedLots > 0) {
    const avgLotDays = totalDays / countedLots;
    avgDaysEl.innerText = `${avgLotDays.toFixed(1)} วัน`;
    avgDaysSubEl.innerText = `เฉลี่ยจาก ${countedLots} ลอตที่ปิดแล้ว`;
  } else {
    // Group unique calendar days in current active lot
    const uniqueDaysInActive = new Set(
      currentLotSales.map(s => new Date(s.created_at).toLocaleDateString('th-TH'))
    ).size;
    avgDaysEl.innerText = uniqueDaysInActive > 0 ? `${uniqueDaysInActive} วัน` : 'เพิ่งเริ่ม';
    avgDaysSubEl.innerText = 'จำนวนวันที่ขายในลอตปัจจุบัน';
  }

  // 2. Group Current Lot Sales by Day (YYYY-MM-DD) & Shift
  const dailyMap = {}; // { '2026-10-31': { label: '31 ต.ค.', lunch: 0, afternoon: 0, total: 0 } }
  let lunchSum = 0;
  let afternoonSum = 0;

  // Iterate chronological order (oldest to newest)
  const chronologicalSales = [...currentLotSales].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  chronologicalSales.forEach(sale => {
    const d = new Date(sale.created_at);
    const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const label = d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
    const amt = parseFloat(sale.amount) || 0;

    if (!dailyMap[dayKey]) {
      dailyMap[dayKey] = { label, lunch: 0, afternoon: 0, total: 0 };
    }

    if (sale.shift === 'afternoon') {
      dailyMap[dayKey].afternoon += amt;
      afternoonSum += amt;
    } else {
      dailyMap[dayKey].lunch += amt;
      lunchSum += amt;
    }
    dailyMap[dayKey].total += amt;
  });

  const dayEntries = Object.values(dailyMap);
  const numSellingDays = dayEntries.length;
  const totalCollected = parseFloat(activeLot.total_collected) || 0;
  const cost = parseFloat(activeLot.cost) || 5000;

  // Average daily sale & estimated days to break-even
  const avgDaily = numSellingDays > 0 ? Math.round(totalCollected / numSellingDays) : 0;
  avgDailySaleEl.innerText = `฿${avgDaily.toLocaleString('th-TH')}`;

  if (totalCollected >= cost) {
    estDaysLeftEl.innerText = 'คืนทุนเรียบร้อยแล้ว!';
  } else if (avgDaily > 0) {
    const estMoreDays = Math.ceil((cost - totalCollected) / avgDaily);
    estDaysLeftEl.innerText = `คาดว่าอีก ~${estMoreDays} วันคืนทุน`;
  } else {
    estDaysLeftEl.innerText = 'รอข้อมูลการขายเพื่อคาดการณ์';
  }

  // Shift Breakdown
  const grandShiftTotal = lunchSum + afternoonSum;
  const lunchPct = grandShiftTotal > 0 ? Math.round((lunchSum / grandShiftTotal) * 100) : 0;
  const afternoonPct = grandShiftTotal > 0 ? (100 - lunchPct) : 0;

  lunchTotalEl.innerText = `฿${lunchSum.toLocaleString('th-TH')}`;
  lunchPctEl.innerText = `สัดส่วน ${lunchPct}% ของลอตนี้`;
  afternoonTotalEl.innerText = `฿${afternoonSum.toLocaleString('th-TH')}`;
  afternoonPctEl.innerText = `สัดส่วน ${afternoonPct}% ของลอตนี้`;

  // 3. Render Bar Chart
  if (dayEntries.length === 0) {
    chartContainer.innerHTML = `
      <div class="w-full h-full flex items-center justify-center text-xs text-slate-400">
        ยังไม่มีข้อมูลกราฟในลอตนี้ (เมื่อบันทึกยอดขาย กราฟรายวันจะแสดงที่นี่)
      </div>
    `;
    return;
  }

  const maxDayTotal = Math.max(...dayEntries.map(d => d.total), 100);

  chartContainer.innerHTML = dayEntries.map(day => {
    const totalHeightPct = Math.max(12, Math.round((day.total / maxDayTotal) * 100));
    const lunchRatio = day.total > 0 ? Math.round((day.lunch / day.total) * 100) : 100;
    const afternoonRatio = 100 - lunchRatio;

    return `
      <div class="flex-1 min-w-[54px] max-w-[90px] h-full flex flex-col justify-end items-center group">
        <!-- Amount Label Above Bar -->
        <span class="text-[10px] font-mono font-bold text-slate-700 mb-1">฿${day.total.toLocaleString('th-TH')}</span>
        
        <!-- Stacked Bar -->
        <div class="w-9 sm:w-11 bg-slate-200/70 rounded-t-xl overflow-hidden flex flex-col justify-end chart-bar-anim shadow-sm border border-slate-200" 
             style="height: ${totalHeightPct}%"
             title="${day.label}: รวม ฿${day.total.toLocaleString('th-TH')} (เที่ยง ฿${day.lunch.toLocaleString('th-TH')} / บ่าย ฿${day.afternoon.toLocaleString('th-TH')})">
          ${day.afternoon > 0 ? `<div class="w-full bg-sky-500 transition-all" style="height: ${afternoonRatio}%"></div>` : ''}
          ${day.lunch > 0 ? `<div class="w-full bg-amber-500 transition-all" style="height: ${lunchRatio}%"></div>` : ''}
        </div>

        <!-- Date Label Below Bar -->
        <span class="text-[10px] font-semibold text-slate-500 mt-1.5 whitespace-nowrap">${day.label}</span>
      </div>
    `;
  }).join('');
}

// --- SECTION 2: DAILY CASH INPUT (NUMPAD, SHIFT, FLOAT, NOTE) ---
function selectShift(shift) {
  selectedShift = shift;
  const lunchBtn = document.getElementById('shift-btn-lunch');
  const afternoonBtn = document.getElementById('shift-btn-afternoon');

  if (shift === 'lunch') {
    lunchBtn.className = 'shift-btn active py-2.5 px-4 rounded-xl border border-slate-200 text-xs sm:text-sm font-bold transition flex items-center justify-center space-x-2';
    afternoonBtn.className = 'shift-btn py-2.5 px-4 rounded-xl border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 text-xs sm:text-sm font-bold transition flex items-center justify-center space-x-2';
  } else {
    afternoonBtn.className = 'shift-btn active py-2.5 px-4 rounded-xl border border-slate-200 text-xs sm:text-sm font-bold transition flex items-center justify-center space-x-2';
    lunchBtn.className = 'shift-btn py-2.5 px-4 rounded-xl border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 text-xs sm:text-sm font-bold transition flex items-center justify-center space-x-2';
  }
}

function appendNoteTag(tagText, isNoSaleDay = false) {
  const noteInput = document.getElementById('sale-note-input');
  if (!noteInput) return;
  const current = noteInput.value.trim();
  noteInput.value = current ? `${current}, ${tagText}` : tagText;

  if (isNoSaleDay) {
    currentInputAmount = '0';
    const deductCheckbox = document.getElementById('deduct-float-checkbox');
    if (deductCheckbox) deductCheckbox.checked = false;
    updateInputField();
    playWallsChime('tap');
    showToast(`เลือกหมายเหตุ "${tagText}" (ตั้งยอด ฿0 สำหรับวันงดขายแล้ว กดปุ่มบันทึกได้เลย)`, 'info');
  }
}

function numpadInput(digit) {
  if (currentInputAmount === '0' && digit !== '.') {
    currentInputAmount = digit;
  } else {
    if (currentInputAmount.length < 7) {
      currentInputAmount += digit;
    }
  }
  updateInputField();
}

function numpadClear() {
  currentInputAmount = '';
  updateInputField();
}

function numpadBackspace() {
  currentInputAmount = currentInputAmount.slice(0, -1);
  updateInputField();
}

function addPresetAmount(val) {
  const current = parseFloat(currentInputAmount) || 0;
  currentInputAmount = (current + val).toString();
  playWallsChime('tap');
  updateInputField();
}

function updateInputField() {
  const inputEl = document.getElementById('cash-input-field');
  const deductCheckbox = document.getElementById('deduct-float-checkbox');
  const labelEl = document.getElementById('cash-input-label');
  const netBadge = document.getElementById('net-sale-badge');
  const previewText = document.getElementById('float-calc-preview');

  if (!inputEl) return;
  inputEl.value = currentInputAmount;

  const rawVal = parseFloat(currentInputAmount) || 0;
  const floatAmt = activeLot && activeLot.float_money !== undefined ? parseFloat(activeLot.float_money) : 500;

  if (deductCheckbox && deductCheckbox.checked) {
    labelEl.innerText = 'เงินสดรวมในกล่อง (รวมเงินทอนตั้งต้น):';
    const netSale = Math.max(0, rawVal - floatAmt);
    netBadge.classList.remove('hidden');
    netBadge.innerText = `ยอดขายสุทธิ: ฿${netSale.toLocaleString('th-TH')}`;
    previewText.innerHTML = rawVal > 0
      ? `เงินนับรวม <strong>฿${rawVal.toLocaleString('th-TH')}</strong> - หักเงินทอน <strong>฿${floatAmt.toLocaleString('th-TH')}</strong> = บันทึกยอดขายจริง <strong class="text-emerald-700">฿${netSale.toLocaleString('th-TH')}</strong>`
      : `กรอกเงินรวมในกล่อง ระบบจะหักเงินทอน ฿${floatAmt.toLocaleString('th-TH')} ออกให้อัตโนมัติ`;
  } else if (labelEl && netBadge && previewText) {
    labelEl.innerText = 'ยอดเงินสดที่ขายได้สุทธิ (บาท):';
    netBadge.classList.add('hidden');
    previewText.innerText = 'หากติ๊กถูก: เพียงกรอกเงินทั้งหมดที่นับได้ในกล่อง ระบบจะหักเงินทอนตั้งต้นออกให้เอง';
  }
}

function initNumpadKeyboardSupport() {
  window.addEventListener('keydown', (e) => {
    const inputTab = document.getElementById('tab-input');
    if (!inputTab || inputTab.classList.contains('hidden')) return;

    // Do not intercept keys if user is typing inside a text input / textarea (e.g. Note field or Modal)
    const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    const isReadonlyInput = document.activeElement && document.activeElement.id === 'cash-input-field';
    if ((activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') && !isReadonlyInput) {
      return;
    }

    if (e.key >= '0' && e.key <= '9') {
      numpadInput(e.key);
    } else if (e.key === 'Backspace') {
      numpadBackspace();
    } else if (e.key === 'Escape' || e.key === 'c' || e.key === 'C') {
      numpadClear();
    } else if (e.key === 'Enter') {
      submitDailySale();
    }
  });
}

async function submitDailySale() {
  const noteInput = document.getElementById('sale-note-input');
  const noteText = noteInput ? noteInput.value.trim() : '';
  const rawInput = currentInputAmount === '' ? (noteText ? 0 : NaN) : parseFloat(currentInputAmount);

  if (isNaN(rawInput) || rawInput < 0 || (rawInput === 0 && !noteText)) {
    showToast('กรุณากรอกยอดเงินสด (มากกว่า 0 บาท) หรือระบุหมายเหตุกรณีวันที่ไม่ได้ขาย', 'error');
    return;
  }

  if (!activeLot) {
    showToast('ไม่พบลอตการขายที่กำลังทำงาน กรุณารีเฟรชระบบ', 'error');
    return;
  }

  const deductCheckbox = document.getElementById('deduct-float-checkbox');
  const floatAmt = activeLot.float_money !== undefined ? parseFloat(activeLot.float_money) : 500;
  let finalAmount = rawInput;
  let floatDeducted = 0;

  if (rawInput > 0 && deductCheckbox && deductCheckbox.checked) {
    if (rawInput <= floatAmt) {
      showToast(`ยอดเงินรวมในกล่อง (฿${rawInput}) น้อยกว่าหรือเท่ากับเงินทอนตั้งต้น (฿${floatAmt})`, 'error');
      return;
    }
    finalAmount = rawInput - floatAmt;
    floatDeducted = floatAmt;
  }

  const btnSubmit = document.getElementById('btn-submit-sale');
  btnSubmit.disabled = true;
  btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> กำลังบันทึกยอด...';

  const success = await insertDailySale(activeLot.id, finalAmount, selectedShift, noteText, floatDeducted);

  btnSubmit.disabled = false;
  btnSubmit.innerHTML = '<i class="fa-solid fa-circle-check text-xl"></i> <span>บันทึกยอดเงินสด (Submit)</span>';

  if (success) {
    playWallsChime('success');
    const shiftLabel = selectedShift === 'afternoon' ? 'พักบ่าย' : 'พักเที่ยง';
    if (finalAmount === 0) {
      showToast(`📌 บันทึกวันงดขาย (${noteText}) เรียบร้อยแล้ว!`, 'success');
    } else {
      showToast(`🔔 กริ๊งๆ! บันทึกยอดกะ${shiftLabel} +฿${finalAmount.toLocaleString('th-TH')} บาท เรียบร้อยแล้ว!`, 'success');
    }
    currentInputAmount = '';
    if (noteInput) noteInput.value = '';
    if (deductCheckbox) deductCheckbox.checked = false;
    updateInputField();

    await loadActiveLotData();
    switchTab('dashboard');
  }
}

// --- SECTION 3: HISTORY (ประวัติลอต & ตารางสรุปบัญชีรายรับ-รายจ่าย รายลอต) ---
async function loadHistoryData() {
  const listContainer = document.getElementById('history-lots-list');
  const totalProfitEl = document.getElementById('hist-total-profit');
  const ledgerTbody = document.getElementById('hist-lot-ledger-tbody');

  listContainer.innerHTML = '<div class="col-span-full text-center py-10 text-xs text-slate-400"><i class="fa-solid fa-spinner fa-spin text-xl mb-2"></i><br>กำลังโหลดประวัติลอต...</div>';

  closedLots = await fetchClosedLotsWithDetails();
  if (!activeLot) activeLot = await fetchActiveLot();

  // Build chronological list of all lots (oldest = ลอตที่ 1, ..., newest)
  const chronologicalClosed = [...closedLots].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const allLotsChronological = activeLot ? [...chronologicalClosed, activeLot] : chronologicalClosed;

  // Render On-Screen Lot Summary Accounting Table (แสดงเฉพาะลอตที่ปิดรอบแล้ว เพื่อไม่ให้ลอตที่กำลังขายมาดึงกำไรรวมติดลบ)
  if (ledgerTbody) {
    let sumIncome = 0;
    let sumExpense = 0;
    let sumProfit = 0;

    if (chronologicalClosed.length === 0) {
      ledgerTbody.innerHTML = '<tr><td colspan="6" class="py-6 text-center text-slate-400">ยังไม่มีข้อมูลลอตการขายที่ปิดรอบแล้ว (เมื่อกดปิดลอต ข้อมูลสรุปจะแสดงที่นี่)</td></tr>';
    } else {
      ledgerTbody.innerHTML = chronologicalClosed.map((lot, idx) => {
        const lotNumber = idx + 1;
        const income = parseFloat(lot.total_collected) || 0;
        const expense = parseFloat(lot.cost) || 5000;
        const profit = income - expense;

        sumIncome += income;
        sumExpense += expense;
        sumProfit += profit;

        const startObj = new Date(lot.created_at);
        const endObj = lot.closed_at ? new Date(lot.closed_at) : new Date();
        const startStr = startObj.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
        const endStr = lot.closed_at
          ? endObj.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' })
          : '-';

        const profitClass = profit >= 0 ? 'text-emerald-600' : 'text-rose-600';

        return `
          <tr class="hover:bg-slate-50 transition">
            <td class="py-3 px-4 font-bold text-slate-800">
              ลอตที่ ${lotNumber}
            </td>
            <td class="py-3 px-4 text-slate-600">${startStr} - ${endStr}</td>
            <td class="py-3 px-4 text-right font-mono font-bold text-blue-600">฿${income.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
            <td class="py-3 px-4 text-right font-mono font-bold text-rose-600">฿${expense.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
            <td class="py-3 px-4 text-right font-mono font-extrabold ${profitClass}">
              ${profit >= 0 ? '+' : ''}฿${profit.toLocaleString('th-TH', { minimumFractionDigits: 2 })}
            </td>
            <td class="py-3 px-4 text-center">
              <span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                ปิดรอบแล้ว
              </span>
            </td>
          </tr>
        `;
      }).join('');
    }

    document.getElementById('hist-tfoot-income').innerText = `฿${sumIncome.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
    document.getElementById('hist-tfoot-expense').innerText = `฿${sumExpense.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
    const tfootProfitEl = document.getElementById('hist-tfoot-profit');
    tfootProfitEl.innerText = `${sumProfit >= 0 ? '+' : ''}฿${sumProfit.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
    tfootProfitEl.className = `py-3 px-4 text-right font-mono font-extrabold ${sumProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`;
  }

  // Render On-Screen Table 2: Daily Transaction Ledger (ตารางแบบที่ 2: แจกแจงรายวัน)
  const dailyFilterEl = document.getElementById('hist-daily-filter');
  await renderOnScreenDailyLedger(dailyFilterEl ? dailyFilterEl.value : 'all');

  let totalLifetimeProfit = 0;

  if (closedLots.length === 0) {
    listContainer.innerHTML = `
      <div class="col-span-full text-center py-12 text-slate-400 bg-white rounded-3xl p-6 border border-slate-200">
        <i class="fa-solid fa-box-archive text-4xl text-slate-300 mb-3 block"></i>
        <p class="text-xs font-semibold">ยังไม่มีประวัติลอตที่ปิดรอบ</p>
        <p class="text-[11px] text-slate-400 mt-1">เมื่อคุณกด "ปิดลอตการขาย" ในหน้าแรก ประวัติจะมาแสดงที่นี่</p>
      </div>
    `;
    totalProfitEl.innerText = '฿0.00';
    return;
  }

  // Map lot ID to its chronological Lot Number (ลอตที่ 1, 2, ...)
  const lotNumMap = {};
  chronologicalClosed.forEach((l, i) => {
    lotNumMap[l.id] = i + 1;
  });

  listContainer.innerHTML = closedLots.map((lot) => {
    const lotNumber = lotNumMap[lot.id] || '-';
    const cost = parseFloat(lot.cost) || 5000;
    const collected = parseFloat(lot.total_collected) || 0;
    const profit = collected - cost;
    totalLifetimeProfit += profit;

    const startObj = new Date(lot.created_at);
    const endObj = lot.closed_at ? new Date(lot.closed_at) : new Date();
    const durationDays = Math.max(1, Math.round((endObj - startObj) / (1000 * 60 * 60 * 24)));

    const startDate = startObj.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
    const endDate = lot.closed_at 
      ? endObj.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' })
      : '-';

    const isProfitable = profit >= 0;

    return `
      <div class="bg-white rounded-3xl p-5 shadow-sm border border-slate-200 hover:border-slate-300 hover:shadow-md transition space-y-3 flex flex-col justify-between">
        <div class="space-y-3">
          <!-- Top Row: Lot Number & Date Range -->
          <div class="flex items-center justify-between text-xs border-b border-slate-100 pb-2.5">
            <div class="flex items-center space-x-2">
              <span class="font-bold text-slate-800 text-xs sm:text-sm">ลอตที่ ${lotNumber}</span>
              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-600">${durationDays} วัน</span>
            </div>
            <span class="text-slate-400 text-[11px]">${startDate} - ${endDate}</span>
          </div>

          <!-- Metrics Grid -->
          <div class="grid grid-cols-3 gap-2 text-center py-1">
            <div class="bg-slate-50 p-2.5 rounded-xl border border-slate-100">
              <span class="text-[10px] text-slate-400 block">รายรับ</span>
              <span class="font-bold text-xs sm:text-sm text-blue-600 font-mono">฿${collected.toLocaleString('th-TH')}</span>
            </div>
            <div class="bg-slate-50 p-2.5 rounded-xl border border-slate-100">
              <span class="text-[10px] text-slate-400 block">รายจ่าย</span>
              <span class="font-bold text-xs sm:text-sm text-rose-600 font-mono">฿${cost.toLocaleString('th-TH')}</span>
            </div>
            <div class="p-2.5 rounded-xl border ${isProfitable ? 'bg-emerald-50 text-emerald-800 border-emerald-100' : 'bg-rose-50 text-rose-800 border-rose-100'}">
              <span class="text-[10px] block opacity-80">กำไรสุทธิ</span>
              <span class="font-black text-xs sm:text-sm font-mono">
                ${isProfitable ? '+' : ''}฿${profit.toLocaleString('th-TH')}
              </span>
            </div>
          </div>
        </div>

        <!-- Bottom Action Row -->
        <div class="text-[11px] text-slate-400 flex items-center justify-between pt-2 border-t border-slate-100">
          <span class="font-medium ${isProfitable ? 'text-emerald-600' : 'text-slate-500'}">
            ${isProfitable ? '✓ ได้กำไรตามเป้า' : 'ของเหลือยกไปลอตใหม่'}
          </span>
          <button onclick="openA4ReportModal('${lot.id}')" class="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-rose-50 text-slate-600 hover:text-rose-600 font-semibold transition flex items-center gap-1">
            <i class="fa-solid fa-list-ul text-[10px]"></i> ดูรายวันลอตนี้
          </button>
        </div>
      </div>
    `;
  }).join('');

  totalProfitEl.innerText = `${totalLifetimeProfit >= 0 ? '+' : ''}฿${totalLifetimeProfit.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
}

// ========================================================
// 4. Modals: Edit Cost/Float, Edit/Delete Sale, Close Lot, Config
// ========================================================
function openEditCostModal() {
  if (!activeLot) return;
  document.getElementById('edit-lot-cost-input').value = parseFloat(activeLot.cost) || 5000;
  document.getElementById('edit-lot-float-input').value = activeLot.float_money !== undefined ? parseFloat(activeLot.float_money) : 500;
  document.getElementById('edit-cost-modal').classList.remove('hidden');
}

async function handleSaveCostAndFloat(e) {
  e.preventDefault();
  if (!activeLot) return;

  const newCost = parseFloat(document.getElementById('edit-lot-cost-input').value);
  const newFloat = parseFloat(document.getElementById('edit-lot-float-input').value);

  if (!newCost || newCost <= 0) {
    showToast('กรุณาระบุต้นทุนที่มากกว่า 0 บาท', 'error');
    return;
  }

  await updateLotCostAndFloatDB(activeLot.id, newCost, isNaN(newFloat) ? 0 : newFloat);
  closeModal('edit-cost-modal');
  showToast('บันทึกการแก้ไขต้นทุนและเงินทอนตั้งต้นเรียบร้อยแล้ว', 'success');
  await loadActiveLotData();
  updateInputField();
}

function openEditSaleModal(saleId) {
  const sale = currentLotSales.find(s => s.id === saleId);
  if (!sale) return;

  document.getElementById('edit-sale-id').value = sale.id;
  document.getElementById('edit-sale-amount').value = parseFloat(sale.amount) || 0;
  document.getElementById('edit-sale-shift').value = sale.shift || 'lunch';
  document.getElementById('edit-sale-note').value = sale.note || '';

  const d = new Date(sale.created_at);
  document.getElementById('edit-sale-timestamp').innerText = `บันทึกเมื่อ: ${d.toLocaleDateString('th-TH')} เวลา ${d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} น.`;

  document.getElementById('edit-sale-modal').classList.remove('hidden');
}

async function handleUpdateDailySale(e) {
  e.preventDefault();
  if (!activeLot) return;

  const saleId = document.getElementById('edit-sale-id').value;
  const newAmt = parseFloat(document.getElementById('edit-sale-amount').value);
  const newShift = document.getElementById('edit-sale-shift').value;
  const newNote = document.getElementById('edit-sale-note').value.trim();

  if (!newAmt || newAmt <= 0) {
    showToast('กรุณาระบุยอดขายที่ถูกต้อง', 'error');
    return;
  }

  await updateDailySaleDB(saleId, activeLot.id, newAmt, newShift, newNote);
  closeModal('edit-sale-modal');
  showToast('แก้ไขข้อมูลยอดขายเรียบร้อยแล้ว', 'success');
  await loadActiveLotData();
}

async function handleDeleteDailySale() {
  if (!activeLot) return;
  const saleId = document.getElementById('edit-sale-id').value;
  if (!saleId) return;

  if (!confirm('ยืนยันการลบรายการบันทึกยอดขายนี้? ระบบจะคำนวณยอดสะสมใหม่ทันที')) return;

  await deleteDailySaleDB(saleId, activeLot.id);
  closeModal('edit-sale-modal');
  showToast('ลบรายการยอดขายและคำนวณยอดสะสมใหม่เรียบร้อย', 'info');
  await loadActiveLotData();
}

function confirmCloseLot() {
  if (!activeLot) return;

  const cost = parseFloat(activeLot.cost) || 5000;
  const collected = parseFloat(activeLot.total_collected) || 0;
  const profit = collected - cost;

  document.getElementById('modal-close-cost').innerText = `฿${cost.toLocaleString('th-TH')}`;
  document.getElementById('modal-close-collected').innerText = `฿${collected.toLocaleString('th-TH')}`;
  
  const profitEl = document.getElementById('modal-close-profit');
  profitEl.innerText = `${profit >= 0 ? '+' : ''}฿${profit.toLocaleString('th-TH')}`;
  profitEl.className = profit >= 0 ? 'font-mono text-emerald-600 font-bold' : 'font-mono text-rose-600 font-bold';

  document.getElementById('close-lot-modal').classList.remove('hidden');
}

async function executeCloseLot() {
  if (!activeLot) return;

  const btnAction = document.getElementById('btn-confirm-close-action');
  btnAction.disabled = true;
  btnAction.innerText = 'กำลังปิดลอตและสร้างลอตใหม่...';

  const newLot = await closeActiveLotAndStartNew(activeLot.id);

  btnAction.disabled = false;
  btnAction.innerText = 'ยืนยันปิดลอต & เปิดใหม่';
  closeModal('close-lot-modal');

  if (newLot) {
    showToast('ปิดลอตเดิมสำเร็จ! เปิดลอตใหม่เรียบร้อยแล้ว', 'success');
    await loadActiveLotData();
  }
}

// ========================================================
// 4.5 Official A4 Income-Expense Ledger Report & Excel Export
// ========================================================
async function buildLedgerData(scope) {
  const closed = await fetchClosedLotsWithDetails();
  if (!activeLot) activeLot = await fetchActiveLot();

  // Chronological order (oldest = ลอตที่ 1)
  const chronologicalClosed = [...closed].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const allLotsChronological = activeLot ? [...chronologicalClosed, activeLot] : chronologicalClosed;

  // MODE 1 (DEFAULT): สรุปบัญชีรายรับ-รายจ่าย รายลอต เฉพาะลอตที่ปิดรอบแล้ว (ไม่รวมลอตที่กำลังขาย)
  if (scope === 'lot_summary') {
    const lotRows = [];
    let totalIncome = 0;
    let totalExpense = 0;

    chronologicalClosed.forEach((lot, idx) => {
      const lotNumber = idx + 1;
      const income = parseFloat(lot.total_collected) || 0;
      const expense = parseFloat(lot.cost) || 5000;
      const profit = income - expense;

      totalIncome += income;
      totalExpense += expense;

      const startObj = new Date(lot.created_at);
      const endObj = lot.closed_at ? new Date(lot.closed_at) : new Date();
      const startStr = startObj.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const endStr = lot.closed_at
        ? endObj.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' })
        : '-';

      lotRows.push({
        lotTitle: `ลอตที่ ${lotNumber}`,
        dateRange: `${startStr} - ${endStr}`,
        income,
        expense,
        profit,
        statusLabel: 'ปิดรอบแล้ว'
      });
    });

    return {
      mode: 'lot_summary',
      rows: lotRows,
      totalIncome,
      totalExpense,
      netProfit: totalIncome - totalExpense
    };
  }

  // MODE 2: แจกแจงรายวัน (ค่าเริ่มต้น 'all' จะแสดงเฉพาะลอตที่ปิดรอบแล้ว ส่วน 'active' แสดงเฉพาะลอตปัจจุบัน)
  let targetLots = [];
  if (scope === 'active' && activeLot) {
    targetLots = [activeLot];
  } else if (scope === 'all' || scope === 'closed') {
    targetLots = chronologicalClosed;
  } else {
    const found = allLotsChronological.find(l => l.id === scope);
    if (found) targetLots = [found];
  }

  const rows = [];
  let totalIncome = 0;
  let totalExpense = 0;
  let runningBalance = 0;

  for (const lot of targetLots) {
    const lotIdx = allLotsChronological.findIndex(l => l.id === lot.id);
    const lotNum = lotIdx !== -1 ? lotIdx + 1 : '-';
    const cost = parseFloat(lot.cost) || 5000;
    const lotDate = new Date(lot.created_at);

    totalExpense += cost;
    runningBalance -= cost;
    rows.push({
      dateStr: lotDate.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' }),
      description: `ซื้อไอศกรีมเหมาลอต (ลอตที่ ${lotNum})`,
      shiftLabel: '-',
      income: 0,
      expense: cost,
      balance: runningBalance,
      note: lot.status === 'active' ? 'ลอตปัจจุบัน' : 'ปิดรอบแล้ว'
    });

    const lotSales = await fetchSalesForLot(lot.id);
    const sortedSales = [...lotSales].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    for (const s of sortedSales) {
      const sDate = new Date(s.created_at);
      const amt = parseFloat(s.amount) || 0;
      totalIncome += amt;
      runningBalance += amt;

      const shiftLabel = amt === 0 ? 'งดขาย' : (s.shift === 'afternoon' ? 'พักบ่าย' : 'พักเที่ยง');
      rows.push({
        dateStr: sDate.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' }),
        description: amt === 0 ? `งดขายไอศกรีม (ลอตที่ ${lotNum})` : `รายรับขายไอศกรีม (ลอตที่ ${lotNum})`,
        shiftLabel,
        income: amt,
        expense: 0,
        balance: runningBalance,
        note: s.note || ''
      });
    }
  }

  return { mode: 'daily_detail', rows, totalIncome, totalExpense, netProfit: totalIncome - totalExpense };
}

async function renderOnScreenDailyLedger(filterScope = 'all') {
  const dailyTbody = document.getElementById('hist-daily-ledger-tbody');
  if (!dailyTbody) return;

  const { rows, totalIncome, totalExpense, netProfit } = await buildLedgerData(filterScope === 'active' ? 'active' : 'all');

  if (rows.length === 0) {
    dailyTbody.innerHTML = '<tr><td colspan="7" class="py-6 text-center text-slate-400">ยังไม่มีรายการบันทึกบัญชีรายวัน</td></tr>';
  } else {
    dailyTbody.innerHTML = rows.map(r => `
      <tr class="hover:bg-slate-50 transition">
        <td class="py-2.5 px-3 font-mono text-slate-600">${r.dateStr}</td>
        <td class="py-2.5 px-3 font-medium text-slate-800">${escapeHtml(r.description)}</td>
        <td class="py-2.5 px-3 text-center">
          ${r.shiftLabel === '-' ? '<span class="text-slate-400">-</span>' : `<span class="px-2 py-0.5 rounded text-[10px] font-bold ${r.shiftLabel === 'พักบ่าย' ? 'bg-sky-100 text-sky-700' : 'bg-amber-100 text-amber-700'}">${r.shiftLabel}</span>`}
        </td>
        <td class="py-2.5 px-3 text-right font-mono font-bold text-blue-600">${r.income > 0 ? `฿${r.income.toLocaleString('th-TH', { minimumFractionDigits: 2 })}` : '-'}</td>
        <td class="py-2.5 px-3 text-right font-mono font-bold text-rose-600">${r.expense > 0 ? `฿${r.expense.toLocaleString('th-TH', { minimumFractionDigits: 2 })}` : '-'}</td>
        <td class="py-2.5 px-3 text-right font-mono font-bold ${r.balance >= 0 ? 'text-emerald-600' : 'text-slate-700'}">${r.balance >= 0 ? '+' : ''}฿${r.balance.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
        <td class="py-2.5 px-3 text-slate-500">${escapeHtml(r.note)}</td>
      </tr>
    `).join('');
  }

  document.getElementById('hist-daily-tfoot-income').innerText = `฿${totalIncome.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
  document.getElementById('hist-daily-tfoot-expense').innerText = `฿${totalExpense.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
  const balEl = document.getElementById('hist-daily-tfoot-balance');
  balEl.innerText = `${netProfit >= 0 ? '+' : ''}฿${netProfit.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
  balEl.className = `py-3 px-3 text-right font-mono font-extrabold ${netProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`;
}

async function openA4ReportModal(scope = 'both') {
  currentReportScope = scope;
  const selectEl = document.getElementById('report-scope-select');
  if (selectEl) {
    if (['both', 'lot_summary', 'active', 'all'].includes(scope)) {
      selectEl.value = scope;
    }
  }

  await renderA4ReportContent(scope);
  document.getElementById('a4-report-modal').classList.remove('hidden');
}

async function changeA4ReportScope(newScope) {
  currentReportScope = newScope;
  await renderA4ReportContent(newScope);
}

function buildLotSummaryHtmlParts(rows, totalIncome, totalExpense, netProfit) {
  const theadHtml = `
    <tr class="bg-slate-800 text-white text-xs">
      <th style="width: 14%;" class="px-3 py-2.5 text-center">ลอตการขาย</th>
      <th style="width: 28%;" class="px-3 py-2.5 text-left">ช่วงวันที่จำหน่าย</th>
      <th style="width: 15%;" class="px-3 py-2.5 text-right">รายรับ (บาท)</th>
      <th style="width: 15%;" class="px-3 py-2.5 text-right">รายจ่าย (บาท)</th>
      <th style="width: 15%;" class="px-3 py-2.5 text-right">กำไรสุทธิ (บาท)</th>
      <th style="width: 13%;" class="px-3 py-2.5 text-center">สถานะ</th>
    </tr>
  `;

  const tbodyHtml = rows.length === 0
    ? '<tr><td colspan="6" class="px-3 py-6 text-center text-slate-400">ยังไม่มีข้อมูลลอตการขายที่ปิดรอบแล้ว</td></tr>'
    : rows.map(r => `
        <tr class="even:bg-slate-50/70">
          <td class="px-3 py-2.5 text-center font-bold text-slate-900">${r.lotTitle}</td>
          <td class="px-3 py-2.5 text-slate-700">${r.dateRange}</td>
          <td class="px-3 py-2.5 text-right font-mono font-semibold text-blue-700">${r.income.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td class="px-3 py-2.5 text-right font-mono font-semibold text-rose-700">${r.expense.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td class="px-3 py-2.5 text-right font-mono font-bold ${r.profit >= 0 ? 'text-emerald-700' : 'text-rose-700'}">${r.profit >= 0 ? '+' : ''}${r.profit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td class="px-3 py-2.5 text-center font-medium text-slate-700">${r.statusLabel}</td>
        </tr>
      `).join('');

  const tfootHtml = `
    <tr class="bg-slate-100 font-extrabold text-slate-900 text-xs">
      <td colspan="2" class="px-3 py-3 text-right">รวมลอตที่ปิดแล้วทั้งสิ้น (Total)</td>
      <td class="px-3 py-3 text-right font-mono text-blue-700">${totalIncome.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td class="px-3 py-3 text-right font-mono text-rose-700">${totalExpense.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td class="px-3 py-3 text-right font-mono ${netProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}">${netProfit >= 0 ? '+' : ''}${netProfit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td class="px-3 py-3"></td>
    </tr>
  `;

  return { theadHtml, tbodyHtml, tfootHtml };
}

function buildDailyDetailHtmlParts(rows, totalIncome, totalExpense, netProfit) {
  const theadHtml = `
    <tr class="bg-slate-800 text-white text-xs">
      <th style="width: 13%;" class="px-2.5 py-2.5 text-center">วัน/เดือน/ปี</th>
      <th style="width: 24%;" class="px-3 py-2.5 text-left">รายการบัญชี</th>
      <th style="width: 10%;" class="px-2 py-2.5 text-center">กะเวลา</th>
      <th style="width: 13%;" class="px-2.5 py-2.5 text-right">รายรับ (บาท)</th>
      <th style="width: 13%;" class="px-2.5 py-2.5 text-right">รายจ่าย (บาท)</th>
      <th style="width: 14%;" class="px-2.5 py-2.5 text-right">คงเหลือสะสม</th>
      <th style="width: 13%;" class="px-2.5 py-2.5 text-left">หมายเหตุ</th>
    </tr>
  `;

  const tbodyHtml = rows.length === 0
    ? '<tr><td colspan="7" class="px-3 py-6 text-center text-slate-400">ยังไม่มีรายการบันทึกบัญชี</td></tr>'
    : rows.map(r => `
        <tr class="even:bg-slate-50/70">
          <td class="px-2.5 py-2 text-center font-mono text-[11px] text-slate-700">${r.dateStr}</td>
          <td class="px-3 py-2 font-medium text-slate-800">${escapeHtml(r.description)}</td>
          <td class="px-2 py-2 text-center text-slate-700">${r.shiftLabel}</td>
          <td class="px-2.5 py-2 text-right font-mono font-semibold text-blue-700">${r.income > 0 ? r.income.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}</td>
          <td class="px-2.5 py-2 text-right font-mono font-semibold text-rose-700">${r.expense > 0 ? r.expense.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}</td>
          <td class="px-2.5 py-2 text-right font-mono font-bold ${r.balance >= 0 ? 'text-emerald-700' : 'text-slate-700'}">${r.balance.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td class="px-2.5 py-2 text-slate-600">${escapeHtml(r.note || '-')}</td>
        </tr>
      `).join('');

  const tfootHtml = `
    <tr class="bg-slate-100 font-extrabold text-slate-900 text-xs">
      <td colspan="3" class="px-3 py-3 text-right">รวมทั้งสิ้น (Total)</td>
      <td class="px-2.5 py-3 text-right font-mono text-blue-700">${totalIncome.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td class="px-2.5 py-3 text-right font-mono text-rose-700">${totalExpense.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td class="px-2.5 py-3 text-right font-mono ${netProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}">${netProfit >= 0 ? '+' : ''}${netProfit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td class="px-2.5 py-3"></td>
    </tr>
  `;

  return { theadHtml, tbodyHtml, tfootHtml };
}

async function renderA4ReportContent(scope) {
  const nowStr = new Date().toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  document.getElementById('a4-report-printed-date').innerText = `วันที่ออกรายงาน: ${nowStr} น.`;

  const table1Title = document.getElementById('a4-table1-title');
  const secondTableContainer = document.getElementById('a4-second-table-container');

  if (scope === 'both') {
    const lotData = await buildLedgerData('lot_summary');
    const dailyData = await buildLedgerData('all');

    document.getElementById('a4-report-subtitle').innerText = 'รายงานสรุปบัญชีรายรับ - รายจ่าย รายลอต และแจกแจงรายการรายวัน';
    document.getElementById('a4-total-income').innerText = `฿${lotData.totalIncome.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
    document.getElementById('a4-total-expense').innerText = `฿${lotData.totalExpense.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;

    const netEl = document.getElementById('a4-net-profit');
    netEl.innerText = `${lotData.netProfit >= 0 ? '+' : ''}฿${lotData.netProfit.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
    netEl.className = `text-base sm:text-lg font-extrabold font-mono ${lotData.netProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`;

    table1Title.innerText = '1. ตารางแบบที่ 1: สรุปบัญชีรายรับ - รายจ่าย รายลอต (Lot Summary Ledger)';
    const parts1 = buildLotSummaryHtmlParts(lotData.rows, lotData.totalIncome, lotData.totalExpense, lotData.netProfit);
    document.getElementById('a4-ledger-thead').innerHTML = parts1.theadHtml;
    document.getElementById('a4-ledger-tbody').innerHTML = parts1.tbodyHtml;
    document.getElementById('a4-ledger-tfoot').innerHTML = parts1.tfootHtml;

    secondTableContainer.classList.remove('hidden');
    const parts2 = buildDailyDetailHtmlParts(dailyData.rows, dailyData.totalIncome, dailyData.totalExpense, dailyData.netProfit);
    document.getElementById('a4-ledger2-thead').innerHTML = parts2.theadHtml;
    document.getElementById('a4-ledger2-tbody').innerHTML = parts2.tbodyHtml;
    document.getElementById('a4-ledger2-tfoot').innerHTML = parts2.tfootHtml;
    return;
  }

  secondTableContainer.classList.add('hidden');
  const { mode, rows, totalIncome, totalExpense, netProfit } = await buildLedgerData(scope);

  document.getElementById('a4-report-subtitle').innerText = mode === 'lot_summary'
    ? 'ตารางแบบที่ 1: สรุปบัญชีรายรับ - รายจ่าย แยกตามลอตการจำหน่าย (ไม่รวมรายการย่อยรายวัน)'
    : 'ตารางแบบที่ 2: รายงานแจกแจงรายการรายรับ - รายจ่าย รายวัน';

  document.getElementById('a4-total-income').innerText = `฿${totalIncome.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
  document.getElementById('a4-total-expense').innerText = `฿${totalExpense.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
  
  const netEl = document.getElementById('a4-net-profit');
  netEl.innerText = `${netProfit >= 0 ? '+' : ''}฿${netProfit.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
  netEl.className = `text-base sm:text-lg font-extrabold font-mono ${netProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`;

  if (mode === 'lot_summary') {
    table1Title.innerText = 'ตารางสรุปบัญชีรายรับ - รายจ่าย รายลอต (Lot Summary Ledger)';
    const parts = buildLotSummaryHtmlParts(rows, totalIncome, totalExpense, netProfit);
    document.getElementById('a4-ledger-thead').innerHTML = parts.theadHtml;
    document.getElementById('a4-ledger-tbody').innerHTML = parts.tbodyHtml;
    document.getElementById('a4-ledger-tfoot').innerHTML = parts.tfootHtml;
  } else {
    table1Title.innerText = 'ตารางบัญชีรายรับ - รายจ่าย แจกแจงรายวัน (Daily Transaction Ledger)';
    const parts = buildDailyDetailHtmlParts(rows, totalIncome, totalExpense, netProfit);
    document.getElementById('a4-ledger-thead').innerHTML = parts.theadHtml;
    document.getElementById('a4-ledger-tbody').innerHTML = parts.tbodyHtml;
    document.getElementById('a4-ledger-tfoot').innerHTML = parts.tfootHtml;
  }
}

async function exportCurrentReportToExcel() {
  await exportLedgerToExcel(currentReportScope);
}

async function exportLedgerToExcel() {
  if (!window.XLSX) {
    showToast('ไม่พบไลบรารีสร้าง Excel กรุณาใช้ปุ่มพิมพ์รายงาน A4 แทน', 'warning');
    return;
  }

  // Always export BOTH sheets (Sheet 1: สรุปรายลอต, Sheet 2: แจกแจงรายวัน) into the Excel file!
  const lotData = await buildLedgerData('lot_summary');
  const dailyData = await buildLedgerData('all');

  // Sheet 1: สรุปรายลอต (Lot Summary)
  const sheet1Data = [
    ['ตารางแบบที่ 1: สรุปบัญชีรายรับ - รายจ่าย รายลอต (ไม่รวมรายวัน)'],
    [`วันที่ส่งออกข้อมูล: ${new Date().toLocaleDateString('th-TH')}`],
    [],
    ['ลอตการขาย', 'ช่วงวันที่จำหน่าย', 'รายรับ (บาท)', 'รายจ่าย / ต้นทุน (บาท)', 'กำไรสุทธิ (บาท)', 'สถานะ']
  ];
  lotData.rows.forEach(r => {
    sheet1Data.push([r.lotTitle, r.dateRange, r.income, r.expense, r.profit, r.statusLabel]);
  });
  sheet1Data.push([]);
  sheet1Data.push(['', 'รวมลอตที่ปิดแล้วทั้งสิ้น (Total)', lotData.totalIncome, lotData.totalExpense, lotData.netProfit, lotData.netProfit >= 0 ? 'กำไรสุทธิ' : 'ขาดทุน']);

  const ws1 = window.XLSX.utils.aoa_to_sheet(sheet1Data);
  ws1['!cols'] = [{ wch: 16 }, { wch: 34 }, { wch: 16 }, { wch: 18 }, { wch: 18 }, { wch: 16 }];

  // Sheet 2: แจกแจงรายวัน (Daily Ledger)
  const sheet2Data = [
    ['ตารางแบบที่ 2: บัญชีรายรับ - รายจ่าย แจกแจงรายวัน'],
    [`วันที่ส่งออกข้อมูล: ${new Date().toLocaleDateString('th-TH')}`],
    [],
    ['วัน/เดือน/ปี', 'รายการ (รายละเอียดบัญชี)', 'กะเวลา', 'รายรับ (บาท)', 'รายจ่าย (บาท)', 'คงเหลือสะสม (บาท)', 'หมายเหตุ']
  ];
  dailyData.rows.forEach(r => {
    sheet2Data.push([r.dateStr, r.description, r.shiftLabel, r.income > 0 ? r.income : '', r.expense > 0 ? r.expense : '', r.balance, r.note]);
  });
  sheet2Data.push([]);
  sheet2Data.push(['', 'รวมทั้งสิ้น (Total)', '', dailyData.totalIncome, dailyData.totalExpense, dailyData.netProfit, '']);

  const ws2 = window.XLSX.utils.aoa_to_sheet(sheet2Data);
  ws2['!cols'] = [{ wch: 14 }, { wch: 34 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 24 }];

  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws1, '1_สรุปรายลอต');
  window.XLSX.utils.book_append_sheet(wb, ws2, '2_บัญชีแจกแจงรายวัน');

  const fileName = `รายงานบัญชีขายไอศกรีม_ครบทั้ง2ตาราง_${new Date().toISOString().slice(0, 10)}.xlsx`;
  window.XLSX.writeFile(wb, fileName);
  showToast('ดาวน์โหลดไฟล์ Excel (ครบทั้ง 2 ตาราง: สรุปรายลอต + แจกแจงรายวัน) สำเร็จแล้ว!', 'success');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function openConfigModal() {
  const sbUrl = localStorage.getItem(STORAGE_KEYS.SUPABASE_URL) || DEFAULT_SUPABASE.URL;
  const sbKey = localStorage.getItem(STORAGE_KEYS.SUPABASE_KEY) || DEFAULT_SUPABASE.KEY;

  document.getElementById('cfg-supabase-url').value = sbUrl;
  document.getElementById('cfg-supabase-key').value = sbKey;
  document.getElementById('config-modal').classList.remove('hidden');
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.add('hidden');
}

async function handleSaveConfig(e) {
  e.preventDefault();
  const url = document.getElementById('cfg-supabase-url').value.trim();
  const key = document.getElementById('cfg-supabase-key').value.trim();

  if (!url || !key) {
    showToast('กรุณากรอกทั้ง URL และ Key ให้ครบถ้วน', 'error');
    return;
  }

  localStorage.setItem(STORAGE_KEYS.SUPABASE_URL, url);
  localStorage.setItem(STORAGE_KEYS.SUPABASE_KEY, key);
  localStorage.removeItem(STORAGE_KEYS.STORAGE_MODE);

  closeModal('config-modal');
  showToast('บันทึกการตั้งค่าแล้ว กำลังเชื่อมต่อ Supabase...', 'info');

  await setupDatabaseClient();
  await loadActiveLotData();
}

function useDemoMode() {
  localStorage.setItem(STORAGE_KEYS.STORAGE_MODE, 'local');
  closeModal('config-modal');
  showToast('สลับมาใช้โหมดจัดเก็บข้อมูลในเครื่อง (Local Mode) เรียบร้อย', 'info');
  setupDatabaseClient();
  loadActiveLotData();
}

function clearLocalDataAndReset() {
  if (!confirm('ยืนยันล้างข้อมูลแคชทดสอบในเครื่องและเริ่มนับใหม่?')) return;
  localStorage.removeItem(STORAGE_KEYS.LOCAL_LOTS);
  localStorage.removeItem(STORAGE_KEYS.LOCAL_SALES);
  localStorage.removeItem(STORAGE_KEYS.LOCAL_ORDER_DRAFT);
  closeModal('config-modal');
  showToast('ล้างแคชทดสอบเรียบร้อย กำลังรีเฟรชระบบ...', 'success');
  setTimeout(() => window.location.reload(), 800);
}

// ========================================================
// 5. Tab Navigation (Supports both Laptop & Mobile)
// ========================================================
function switchTab(tabId) {
  // Hide all sections
  document.querySelectorAll('.tab-pane').forEach(el => el.classList.add('hidden'));

  // Reset Mobile Nav buttons
  document.querySelectorAll('.mob-nav-btn').forEach(btn => {
    btn.classList.remove('active', 'text-rose-600');
    btn.classList.add('text-slate-400');
  });

  // Reset Desktop Nav buttons
  document.querySelectorAll('.desk-nav-btn').forEach(btn => {
    btn.classList.remove('active', 'bg-white', 'text-rose-600', 'shadow-sm');
    btn.classList.add('text-white/90');
  });

  // Activate target pane
  const targetPane = document.getElementById(`tab-${tabId}`);
  if (targetPane) targetPane.classList.remove('hidden');

  // Activate Mobile Nav button
  const targetMobNav = document.getElementById(`nav-btn-${tabId}`);
  if (targetMobNav) {
    targetMobNav.classList.add('active', 'text-rose-600');
    targetMobNav.classList.remove('text-slate-400');
  }

  // Activate Desktop Nav button
  const targetDeskNav = document.getElementById(`desk-nav-${tabId}`);
  if (targetDeskNav) {
    targetDeskNav.classList.add('active', 'bg-white', 'text-rose-600', 'shadow-sm');
    targetDeskNav.classList.remove('text-white/90');
  }

  // Trigger data reload for specific tabs
  if (tabId === 'dashboard') {
    loadActiveLotData();
  } else if (tabId === 'history') {
    loadHistoryData();
  } else if (tabId === 'input') {
    updateInputField();
  } else if (tabId === 'products') {
    loadProductCatalog();
  }

  // Smooth scroll back to top when switching tabs
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ========================================================
// 6. Product Catalog, Margin Calculator & Purchase Order PDF
// ========================================================
function getDefaultWallsProducts() {
  return [
    {
      id: 'walls-cornetto-classic',
      name: 'คอร์เนตโต วานิลลา / ช็อกโกแลต',
      category: 'โคน',
      pieces_per_box: 24,
      cost_per_piece: 15.00,
      retail_price: 20.00
    },
    {
      id: 'walls-cornetto-royale',
      name: 'คอร์เนตโต รอยัล (ขนาดใหญ่)',
      category: 'โคน',
      pieces_per_box: 24,
      cost_per_piece: 22.50,
      retail_price: 30.00
    },
    {
      id: 'walls-paddlepop-rainbow',
      name: 'แพดเดิลป๊อป เรนโบว์ / ทอร์นาโด',
      category: 'แท่ง',
      pieces_per_box: 30,
      cost_per_piece: 11.50,
      retail_price: 15.00
    },
    {
      id: 'walls-topten-choc',
      name: 'ท็อปเท็น ช็อกโกแลต / วานิลลา',
      category: 'แท่ง',
      pieces_per_box: 28,
      cost_per_piece: 11.50,
      retail_price: 15.00
    },
    {
      id: 'walls-asian-delight',
      name: 'เอเชียนดีไลท์ (เผือก / กะทิ / ถั่วดำ)',
      category: 'แท่ง',
      pieces_per_box: 30,
      cost_per_piece: 11.50,
      retail_price: 15.00
    },
    {
      id: 'walls-cup-classic',
      name: 'ไอศกรีมถ้วยวอลล์ (ช็อกชิพ / สตรอว์เบอร์รี)',
      category: 'ถ้วย',
      pieces_per_box: 24,
      cost_per_piece: 15.00,
      retail_price: 20.00
    },
    {
      id: 'walls-sandwich',
      name: 'วอลล์ แซนด์วิช วานิลลา-ช็อกโกแลต',
      category: 'แซนด์วิช/อื่นๆ',
      pieces_per_box: 24,
      cost_per_piece: 15.00,
      retail_price: 20.00
    },
    {
      id: 'walls-magnum-classic',
      name: 'แม็กนั่ม คลาสสิค / อัลมอนด์',
      category: 'แท่ง',
      pieces_per_box: 24,
      cost_per_piece: 32.00,
      retail_price: 40.00
    },
    {
      id: 'walls-calippo-lemon',
      name: 'คาลิปโป เลมอน / โคล่า (หลอดบีบ)',
      category: 'แท่ง',
      pieces_per_box: 24,
      cost_per_piece: 15.00,
      retail_price: 20.00
    }
  ];
}

async function loadProductCatalog() {
  // Load saved order draft quantities
  try {
    orderDraftQuantities = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_ORDER_DRAFT) || '{}');
  } catch (e) {
    orderDraftQuantities = {};
  }

  // Try loading from Supabase if online and table exists, else fallback cleanly to LocalStorage
  let loaded = null;
  if (!isOfflineMode && supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from('products')
        .select('*')
        .order('created_at', { ascending: true });
      if (!error && Array.isArray(data) && data.length > 0) {
        loaded = data;
      }
    } catch (err) {
      // Fallback to local catalog if products table is not yet created
    }
  }

  if (!loaded) {
    try {
      const localRaw = localStorage.getItem(STORAGE_KEYS.LOCAL_PRODUCTS);
      if (localRaw) {
        const parsed = JSON.parse(localRaw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          loaded = parsed;
        }
      }
    } catch (e) {}
  }

  if (!loaded || loaded.length === 0) {
    loaded = getDefaultWallsProducts();
    localStorage.setItem(STORAGE_KEYS.LOCAL_PRODUCTS, JSON.stringify(loaded));
  }

  productCatalog = loaded;

  // If no order draft exists yet, initialize a helpful default selection (~5,000 THB budget) on first visit
  if (Object.keys(orderDraftQuantities).length === 0 && !localStorage.getItem(STORAGE_KEYS.LOCAL_ORDER_DRAFT)) {
    autoFillOrderBudget(5000, true);
  } else {
    renderProductCatalog();
    updateOrderPlannerSummary();
  }
}

function saveProductCatalogLocal() {
  localStorage.setItem(STORAGE_KEYS.LOCAL_PRODUCTS, JSON.stringify(productCatalog));
}

function saveOrderDraftLocal() {
  localStorage.setItem(STORAGE_KEYS.LOCAL_ORDER_DRAFT, JSON.stringify(orderDraftQuantities));
}

function computeProductMetrics(prod) {
  const pieces = Math.max(1, parseInt(prod.pieces_per_box, 10) || 24);
  const costPiece = Math.max(0, parseFloat(prod.cost_per_piece) || 0);
  const retailPiece = Math.max(0, parseFloat(prod.retail_price) || 0);

  const profitPerPiece = retailPiece - costPiece;
  const marginPct = retailPiece > 0 ? (profitPerPiece / retailPiece) * 100 : 0;
  const boxCost = costPiece * pieces;
  const boxRevenue = retailPiece * pieces;
  const boxProfit = boxRevenue - boxCost;

  return {
    pieces,
    costPiece,
    retailPiece,
    profitPerPiece,
    marginPct,
    boxCost,
    boxRevenue,
    boxProfit
  };
}

function setProductCategoryFilter(category) {
  currentProductCategory = category;
  document.querySelectorAll('.prod-cat-btn').forEach(btn => {
    if (btn.getAttribute('data-cat') === category) {
      btn.className = 'prod-cat-btn active px-3 py-1.5 rounded-xl text-xs font-bold bg-rose-600 text-white transition whitespace-nowrap';
    } else {
      btn.className = 'prod-cat-btn px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 text-slate-600 hover:bg-slate-200 transition whitespace-nowrap';
    }
  });
  renderProductCatalog();
}

function renderProductCatalog() {
  const tbody = document.getElementById('product-catalog-tbody');
  const cardsContainer = document.getElementById('product-catalog-cards');
  const countLabel = document.getElementById('product-count-label');
  if (!tbody) return;

  const searchInput = document.getElementById('product-search-input');
  const sortSelect = document.getElementById('product-sort-select');
  const keyword = searchInput ? searchInput.value.trim().toLowerCase() : '';
  const sortBy = sortSelect ? sortSelect.value : 'default';

  let list = productCatalog.map(p => ({
    ...p,
    metrics: computeProductMetrics(p)
  }));

  if (currentProductCategory !== 'all') {
    list = list.filter(p => p.category === currentProductCategory);
  }

  if (keyword) {
    list = list.filter(p =>
      p.name.toLowerCase().includes(keyword) ||
      (p.category && p.category.toLowerCase().includes(keyword))
    );
  }

  if (sortBy === 'box_profit_desc') {
    list.sort((a, b) => b.metrics.boxProfit - a.metrics.boxProfit);
  } else if (sortBy === 'piece_profit_desc') {
    list.sort((a, b) => b.metrics.profitPerPiece - a.metrics.profitPerPiece);
  } else if (sortBy === 'margin_desc') {
    list.sort((a, b) => b.metrics.marginPct - a.metrics.marginPct);
  } else if (sortBy === 'retail_asc') {
    list.sort((a, b) => a.metrics.retailPiece - b.metrics.retailPiece);
  }

  if (countLabel) {
    countLabel.innerText = `แสดง ${list.length} จาก ${productCatalog.length} รายการ`;
  }

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="py-10 text-center text-slate-400">ไม่พบรายการสินค้าที่ค้นหา</td></tr>`;
    if (cardsContainer) {
      cardsContainer.innerHTML = `<div class="bg-white rounded-2xl p-6 text-center text-xs text-slate-400 border border-slate-200">ไม่พบรายการสินค้าที่ค้นหา</div>`;
    }
    return;
  }

  const catIcons = {
    'โคน': '🍦',
    'แท่ง': '🍭',
    'ถ้วย': '🍨',
    'แซนด์วิช/อื่นๆ': '🥪'
  };

  tbody.innerHTML = list.map(p => {
    const m = p.metrics;
    const qty = parseInt(orderDraftQuantities[p.id] || 0, 10);
    const badgeHtml = getWallsFlavorBadge(p);

    return `
      <tr class="hover:bg-rose-50/40 transition ${qty > 0 ? 'bg-indigo-50/40' : ''}">
        <td class="py-3 px-3">
          <div class="font-bold text-slate-800">${escapeHtml(p.name)}</div>
          <div class="mt-1">${badgeHtml}</div>
        </td>
        <td class="py-3 px-2.5 text-center font-mono font-bold text-slate-700">${m.pieces} ชิ้น</td>
        <td class="py-3 px-2.5 text-right font-mono text-rose-600 font-semibold">฿${m.costPiece.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td class="py-3 px-2.5 text-right font-mono font-extrabold text-slate-900 bg-slate-50">฿${m.retailPiece.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td class="py-3 px-2.5 text-right font-mono">
          <span class="font-extrabold text-emerald-600">+฿${m.profitPerPiece.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          <span class="block text-[10px] text-slate-400">(${m.marginPct.toFixed(0)}%)</span>
        </td>
        <td class="py-3 px-2.5 text-right font-mono font-semibold text-rose-700">฿${m.boxCost.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td class="py-3 px-2.5 text-right font-mono font-semibold text-blue-700">฿${m.boxRevenue.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td class="py-3 px-3 text-right font-mono font-extrabold text-sm text-emerald-700 bg-emerald-50/60">+฿${m.boxProfit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td class="py-3 px-3 text-center bg-indigo-50/50">
          <div class="inline-flex items-center space-x-1 bg-white border border-indigo-200 rounded-xl p-1 shadow-sm">
            <button onclick="changeOrderQty('${p.id}', -1)" class="w-6 h-6 rounded-lg bg-slate-100 hover:bg-rose-100 text-slate-700 hover:text-rose-600 font-bold flex items-center justify-center transition">-</button>
            <input type="number" min="0" value="${qty}" onchange="setOrderQtyDirect('${p.id}', this.value)"
                   class="w-10 text-center font-mono font-extrabold text-xs ${qty > 0 ? 'text-indigo-700' : 'text-slate-400'} outline-none bg-transparent">
            <button onclick="changeOrderQty('${p.id}', 1)" class="w-6 h-6 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold flex items-center justify-center transition">+</button>
          </div>
        </td>
        <td class="py-3 px-2.5 text-center">
          <div class="inline-flex items-center space-x-1">
            <button onclick="openProductModal('${p.id}')" class="w-7 h-7 rounded-lg bg-slate-100 hover:bg-blue-50 text-slate-500 hover:text-blue-600 flex items-center justify-center transition" title="แก้ไขสินค้า">
              <i class="fa-solid fa-pen text-[10px]"></i>
            </button>
            <button onclick="deleteProductById('${p.id}')" class="w-7 h-7 rounded-lg bg-slate-100 hover:bg-rose-50 text-slate-400 hover:text-rose-600 flex items-center justify-center transition" title="ลบสินค้า">
              <i class="fa-solid fa-trash-can text-[10px]"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  if (cardsContainer) {
    cardsContainer.innerHTML = list.map(p => {
      const m = p.metrics;
      const qty = parseInt(orderDraftQuantities[p.id] || 0, 10);
      const badgeHtml = getWallsFlavorBadge(p);

      return `
        <div class="bg-white rounded-3xl p-4 shadow-sm border ${qty > 0 ? 'border-indigo-400 ring-2 ring-indigo-100' : 'border-rose-100'} space-y-3">
          <div class="flex items-start justify-between gap-2">
            <div>
              <div class="flex items-center gap-1.5 flex-wrap">
                ${badgeHtml}
                <span class="text-[10px] font-mono font-bold text-slate-500">• ${m.pieces} ชิ้น/ลัง</span>
              </div>
              <h4 class="font-bold text-sm text-slate-800 mt-1.5">${escapeHtml(p.name)}</h4>
            </div>
            <button onclick="openProductModal('${p.id}')" class="w-8 h-8 rounded-xl bg-slate-100 text-slate-500 flex items-center justify-center shrink-0">
              <i class="fa-solid fa-pen text-xs"></i>
            </button>
          </div>

          <div class="grid grid-cols-3 gap-2 text-center bg-slate-50 p-2.5 rounded-2xl border border-slate-100 text-xs">
            <div>
              <span class="text-[10px] text-slate-400 block">ทุน/ชิ้น</span>
              <span class="font-mono font-bold text-rose-600">฿${m.costPiece.toFixed(2)}</span>
            </div>
            <div class="border-x border-slate-200">
              <span class="text-[10px] text-slate-400 block">ขายหน้าร้าน</span>
              <span class="font-mono font-extrabold text-slate-900">฿${m.retailPiece.toFixed(2)}</span>
            </div>
            <div>
              <span class="text-[10px] text-emerald-600 font-bold block">กำไร/แท่ง</span>
              <span class="font-mono font-extrabold text-emerald-600">+฿${m.profitPerPiece.toFixed(2)}</span>
            </div>
          </div>

          <div class="flex items-center justify-between bg-emerald-50/70 border border-emerald-200/80 px-3 py-2 rounded-2xl text-xs">
            <div>
              <span class="text-[10px] text-slate-500 block">ทุนยกลัง ฿${m.boxCost.toLocaleString('th-TH')} → ขายได้ ฿${m.boxRevenue.toLocaleString('th-TH')}</span>
              <span class="font-bold text-emerald-900">กำไรทั้งลัง: <strong class="font-mono text-sm text-emerald-700">+฿${m.boxProfit.toLocaleString('th-TH')}</strong></span>
            </div>
            <div class="flex items-center space-x-1.5 bg-white border border-indigo-200 rounded-xl p-1 shadow-sm">
              <button onclick="changeOrderQty('${p.id}', -1)" class="w-7 h-7 rounded-lg bg-slate-100 text-slate-700 font-bold">-</button>
              <span class="px-2 font-mono font-extrabold text-xs ${qty > 0 ? 'text-indigo-700' : 'text-slate-400'}">${qty} ลัง</span>
              <button onclick="changeOrderQty('${p.id}', 1)" class="w-7 h-7 rounded-lg bg-indigo-600 text-white font-bold">+</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }
}

function changeOrderQty(productId, delta) {
  const current = parseInt(orderDraftQuantities[productId] || 0, 10);
  const next = Math.max(0, current + delta);
  if (next === 0) {
    delete orderDraftQuantities[productId];
  } else {
    orderDraftQuantities[productId] = next;
  }
  saveOrderDraftLocal();
  renderProductCatalog();
  updateOrderPlannerSummary();
}

function setOrderQtyDirect(productId, val) {
  const parsed = Math.max(0, parseInt(val, 10) || 0);
  if (parsed === 0) {
    delete orderDraftQuantities[productId];
  } else {
    orderDraftQuantities[productId] = parsed;
  }
  saveOrderDraftLocal();
  renderProductCatalog();
  updateOrderPlannerSummary();
}

function clearOrderSelection() {
  orderDraftQuantities = {};
  saveOrderDraftLocal();
  renderProductCatalog();
  updateOrderPlannerSummary();
  showToast('ล้างจำนวนลังที่เลือกไว้เรียบร้อยแล้ว', 'info');
}

function autoFillOrderBudget(targetBudget = 5000, silent = false) {
  if (productCatalog.length === 0) return;
  orderDraftQuantities = {};
  let runningCost = 0;

  // Cycle through products to build a balanced assortment near ~5,000 THB
  let addedInPass = true;
  while (addedInPass && runningCost < targetBudget) {
    addedInPass = false;
    for (const p of productCatalog) {
      const m = computeProductMetrics(p);
      if (m.boxCost > 0 && runningCost + m.boxCost <= targetBudget + 250) {
        orderDraftQuantities[p.id] = (orderDraftQuantities[p.id] || 0) + 1;
        runningCost += m.boxCost;
        addedInPass = true;
        if (runningCost >= targetBudget - 150) break;
      }
    }
  }

  saveOrderDraftLocal();
  renderProductCatalog();
  updateOrderPlannerSummary();
  if (!silent) {
    showToast(`จัดชุดสินค้าอัตโนมัติงบประมาณ ฿${runningCost.toLocaleString('th-TH')} เรียบร้อย! ปรับบวก/ลบเพิ่มได้ตามต้องการ`, 'success');
  }
}

function updateOrderPlannerSummary() {
  let totalBoxes = 0;
  let totalPieces = 0;
  let totalCost = 0;
  let totalRevenue = 0;
  let totalProfit = 0;

  for (const p of productCatalog) {
    const qty = parseInt(orderDraftQuantities[p.id] || 0, 10);
    if (qty > 0) {
      const m = computeProductMetrics(p);
      totalBoxes += qty;
      totalPieces += m.pieces * qty;
      totalCost += m.boxCost * qty;
      totalRevenue += m.boxRevenue * qty;
      totalProfit += m.boxProfit * qty;
    }
  }

  const avgMargin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;
  const lotBudget = activeLot ? parseFloat(activeLot.cost) || 5000 : 5000;

  const elBoxes = document.getElementById('planner-total-boxes');
  const elPieces = document.getElementById('planner-total-pieces');
  const elCost = document.getElementById('planner-total-cost');
  const elRev = document.getElementById('planner-total-revenue');
  const elProfit = document.getElementById('planner-total-profit');
  const elMargin = document.getElementById('planner-avg-margin');
  const elBadgeBoxes = document.getElementById('planner-badge-boxes');
  const elBudgetBadge = document.getElementById('planner-budget-badge');

  if (elBoxes) elBoxes.innerText = `${totalBoxes.toLocaleString('th-TH')} ลัง`;
  if (elPieces) elPieces.innerText = `(${totalPieces.toLocaleString('th-TH')} ชิ้น)`;
  if (elCost) elCost.innerText = `฿${totalCost.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (elRev) elRev.innerText = `฿${totalRevenue.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (elProfit) elProfit.innerText = `+฿${totalProfit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (elMargin) elMargin.innerText = `กำไร ${avgMargin.toFixed(1)}%`;
  if (elBadgeBoxes) elBadgeBoxes.innerText = totalBoxes;
  if (elBudgetBadge) {
    const diff = totalCost - lotBudget;
    if (totalCost === 0) {
      elBudgetBadge.innerText = `งบตั้งต้น ฿${lotBudget.toLocaleString('th-TH')}`;
    } else if (Math.abs(diff) <= 300) {
      elBudgetBadge.innerText = `ใกล้เคียงงบ ฿${lotBudget.toLocaleString('th-TH')}`;
    } else if (diff > 300) {
      elBudgetBadge.innerText = `เกินงบ +฿${diff.toLocaleString('th-TH')}`;
    } else {
      elBudgetBadge.innerText = `ต่ำกว่างบ ฿${Math.abs(diff).toLocaleString('th-TH')}`;
    }
  }
}

// --- Add / Edit Product Modal Logic ---
function openProductModal(productId = null) {
  const idInput = document.getElementById('prod-id-input');
  const nameInput = document.getElementById('prod-name-input');
  const catInput = document.getElementById('prod-category-input');
  const piecesInput = document.getElementById('prod-pieces-input');
  const retailInput = document.getElementById('prod-retail-input');
  const costPieceInput = document.getElementById('prod-cost-piece-input');
  const costBoxInput = document.getElementById('prod-cost-box-input');
  const titleEl = document.getElementById('product-modal-title');
  const btnDelete = document.getElementById('btn-delete-product-modal');

  if (productId) {
    const prod = productCatalog.find(p => p.id === productId);
    if (!prod) return;
    const m = computeProductMetrics(prod);
    titleEl.innerText = 'แก้ไขรายการสินค้าไอศกรีม';
    idInput.value = prod.id;
    nameInput.value = prod.name;
    catInput.value = prod.category || 'โคน';
    piecesInput.value = m.pieces;
    retailInput.value = m.retailPiece;
    costPieceInput.value = m.costPiece;
    costBoxInput.value = m.boxCost.toFixed(2);
    if (btnDelete) btnDelete.classList.remove('hidden');
  } else {
    titleEl.innerText = 'เพิ่มรายการสินค้าใหม่';
    idInput.value = '';
    nameInput.value = '';
    catInput.value = 'โคน';
    piecesInput.value = 24;
    retailInput.value = 20;
    costPieceInput.value = 15;
    costBoxInput.value = 360;
    if (btnDelete) btnDelete.classList.add('hidden');
  }

  onProductFormCalc('init');
  document.getElementById('product-modal').classList.remove('hidden');
}

function onProductFormCalc(source) {
  const pieces = Math.max(1, parseInt(document.getElementById('prod-pieces-input').value, 10) || 1);
  const retail = Math.max(0, parseFloat(document.getElementById('prod-retail-input').value) || 0);
  const costPieceEl = document.getElementById('prod-cost-piece-input');
  const costBoxEl = document.getElementById('prod-cost-box-input');

  let costPiece = parseFloat(costPieceEl.value) || 0;
  let costBox = parseFloat(costBoxEl.value) || 0;

  if (source === 'cost_box') {
    costPiece = costBox / pieces;
    costPieceEl.value = costPiece ? parseFloat(costPiece.toFixed(4)) : '';
  } else if (source === 'cost_piece' || source === 'pieces' || source === 'init') {
    costBox = costPiece * pieces;
    costBoxEl.value = costBox ? parseFloat(costBox.toFixed(2)) : '';
  }

  const profitPiece = retail - costPiece;
  const marginPct = retail > 0 ? (profitPiece / retail) * 100 : 0;
  const boxRev = retail * pieces;
  const boxProfit = boxRev - (costPiece * pieces);

  document.getElementById('prod-preview-piece-profit').innerText = `${profitPiece >= 0 ? '+' : ''}฿${profitPiece.toFixed(2)} (${marginPct.toFixed(1)}%)`;
  document.getElementById('prod-preview-box-rev').innerText = `฿${boxRev.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  document.getElementById('prod-preview-box-profit').innerText = `${boxProfit >= 0 ? '+' : ''}฿${boxProfit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function handleSaveProduct(e) {
  e.preventDefault();
  const id = document.getElementById('prod-id-input').value.trim();
  const name = document.getElementById('prod-name-input').value.trim();
  const category = document.getElementById('prod-category-input').value;
  const pieces_per_box = Math.max(1, parseInt(document.getElementById('prod-pieces-input').value, 10) || 24);
  const cost_per_piece = Math.max(0, parseFloat(document.getElementById('prod-cost-piece-input').value) || 0);
  const retail_price = Math.max(0, parseFloat(document.getElementById('prod-retail-input').value) || 0);

  if (!name) {
    showToast('กรุณาระบุชื่อสินค้า', 'error');
    return;
  }

  if (id) {
    const idx = productCatalog.findIndex(p => p.id === id);
    if (idx > -1) {
      productCatalog[idx] = { ...productCatalog[idx], name, category, pieces_per_box, cost_per_piece, retail_price };
    }
    if (!isOfflineMode && supabaseClient) {
      try {
        await supabaseClient.from('products').upsert(productCatalog[idx]);
      } catch (err) {}
    }
    showToast(`อัปเดตสินค้า "${name}" เรียบร้อยแล้ว`, 'success');
  } else {
    const newProd = {
      id: generateUUID(),
      name,
      category,
      pieces_per_box,
      cost_per_piece,
      retail_price
    };
    productCatalog.push(newProd);
    orderDraftQuantities[newProd.id] = 1;
    saveOrderDraftLocal();

    if (!isOfflineMode && supabaseClient) {
      try {
        await supabaseClient.from('products').insert([newProd]);
      } catch (err) {}
    }
    showToast(`เพิ่มสินค้า "${name}" เรียบร้อยแล้ว`, 'success');
  }

  saveProductCatalogLocal();
  closeModal('product-modal');
  renderProductCatalog();
  updateOrderPlannerSummary();
}

function handleDeleteProductFromModal() {
  const id = document.getElementById('prod-id-input').value.trim();
  if (!id) return;
  closeModal('product-modal');
  deleteProductById(id);
}

async function deleteProductById(productId) {
  const prod = productCatalog.find(p => p.id === productId);
  if (!prod) return;
  if (!confirm(`ต้องการลบสินค้า "${prod.name}" ออกจากรายการใช่หรือไม่?`)) return;

  productCatalog = productCatalog.filter(p => p.id !== productId);
  delete orderDraftQuantities[productId];

  if (!isOfflineMode && supabaseClient) {
    try {
      await supabaseClient.from('products').delete().eq('id', productId);
    } catch (err) {}
  }

  saveProductCatalogLocal();
  saveOrderDraftLocal();
  renderProductCatalog();
  updateOrderPlannerSummary();
  showToast(`ลบสินค้า "${prod.name}" เรียบร้อยแล้ว`, 'info');
}

function resetDefaultProducts() {
  if (!confirm('ต้องการรีเซ็ตรายการสินค้ากลับเป็นค่าเริ่มต้นของไอศกรีมวอลล์ (8 รายการ) ใช่หรือไม่?')) return;
  productCatalog = getDefaultWallsProducts();
  saveProductCatalogLocal();
  autoFillOrderBudget(5000, true);
  showToast('รีเซ็ตรายการสินค้ามาตรฐานเรียบร้อยแล้ว', 'success');
}

// --- Purchase Order (ใบสั่งซื้อสินค้า A4 & PDF Export) ---
function openPurchaseOrderModal() {
  // Load saved PO metadata if available
  try {
    const savedMeta = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_PO_META) || '{}');
    if (savedMeta.buyer) document.getElementById('po-buyer-input').value = savedMeta.buyer;
    if (savedMeta.supplier) document.getElementById('po-supplier-input').value = savedMeta.supplier;
    if (savedMeta.note !== undefined) document.getElementById('po-note-input').value = savedMeta.note;
  } catch (e) {}

  renderPurchaseOrderContent();
  document.getElementById('po-report-modal').classList.remove('hidden');
}

function updatePOHeaderLive() {
  const buyer = document.getElementById('po-buyer-input').value.trim() || 'โครงการจำหน่ายไอศกรีมโรงเรียน';
  const supplier = document.getElementById('po-supplier-input').value.trim() || "ตัวแทนจำหน่ายไอศกรีมวอลล์ (Wall's)";
  const note = document.getElementById('po-note-input').value.trim() || '-';

  document.getElementById('po-sheet-buyer').innerText = `ผู้สั่งซื้อ: ${buyer}`;
  document.getElementById('po-sheet-supplier').innerText = `ผู้จำหน่าย: ${supplier}`;
  document.getElementById('po-sheet-note').innerText = note;

  localStorage.setItem(STORAGE_KEYS.LOCAL_PO_META, JSON.stringify({ buyer, supplier, note }));
}

function renderPurchaseOrderContent() {
  updatePOHeaderLive();

  const now = new Date();
  const dateStr = now.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  document.getElementById('po-sheet-date').innerText = dateStr;
  document.getElementById('po-sheet-number').innerText = `PO-${ymd}`;

  const modeSelect = document.getElementById('po-mode-select');
  const mode = modeSelect ? modeSelect.value : 'supplier'; // 'supplier' | 'internal'

  // Filter items that have order quantity > 0; if none selected, include all products with qty = 1 so PO is never blank
  let orderedItems = productCatalog
    .map(p => ({
      ...p,
      orderQty: parseInt(orderDraftQuantities[p.id] || 0, 10),
      metrics: computeProductMetrics(p)
    }))
    .filter(item => item.orderQty > 0);

  if (orderedItems.length === 0) {
    orderedItems = productCatalog.map(p => ({
      ...p,
      orderQty: 1,
      metrics: computeProductMetrics(p)
    }));
  }

  let totalBoxes = 0;
  let totalPieces = 0;
  let totalCost = 0;
  let totalRevenue = 0;
  let totalProfit = 0;

  orderedItems.forEach(item => {
    totalBoxes += item.orderQty;
    totalPieces += item.metrics.pieces * item.orderQty;
    totalCost += item.metrics.boxCost * item.orderQty;
    totalRevenue += item.metrics.boxRevenue * item.orderQty;
    totalProfit += item.metrics.boxProfit * item.orderQty;
  });

  const stripEl = document.getElementById('po-summary-strip');
  const theadEl = document.getElementById('po-table-thead');
  const tbodyEl = document.getElementById('po-table-tbody');
  const tfootEl = document.getElementById('po-table-tfoot');

  if (mode === 'supplier') {
    // Supplier Mode: Shows ONLY Product Name & Box Quantity for sending cleanly to the shop/supplier
    stripEl.className = 'grid grid-cols-2 gap-3 text-center';
    stripEl.innerHTML = `
      <div class="bg-slate-50 border border-slate-300 rounded-xl p-3">
        <span class="text-[11px] text-slate-500 block">จำนวนรายการที่สั่งซื้อ</span>
        <span class="text-base sm:text-lg font-extrabold font-mono text-slate-800">${orderedItems.length} รายการ</span>
      </div>
      <div class="bg-indigo-50 border border-indigo-300 rounded-xl p-3">
        <span class="text-[11px] text-indigo-700 font-bold block">รวมจำนวนที่สั่งซื้อทั้งหมด</span>
        <span class="text-base sm:text-lg font-extrabold font-mono text-indigo-700">${totalBoxes.toLocaleString('th-TH')} ลัง</span>
      </div>
    `;

    theadEl.innerHTML = `
      <tr class="bg-slate-800 text-white text-xs">
        <th style="width: 15%;" class="py-3 px-3 text-center">ลำดับที่</th>
        <th style="width: 60%;" class="py-3 px-4 text-left">รายการชื่อสินค้า</th>
        <th style="width: 25%;" class="py-3 px-4 text-center">จำนวนที่สั่งซื้อ (ลัง)</th>
      </tr>
    `;

    tbodyEl.innerHTML = orderedItems.map((item, idx) => {
      return `
        <tr class="even:bg-slate-50/70">
          <td class="py-2.5 px-3 text-center font-mono font-semibold text-slate-700">${idx + 1}</td>
          <td class="py-2.5 px-4 font-bold text-sm text-slate-900">${escapeHtml(item.name)}</td>
          <td class="py-2.5 px-4 text-center font-mono font-extrabold text-sm text-indigo-700">${item.orderQty} ลัง</td>
        </tr>
      `;
    }).join('');

    tfootEl.innerHTML = `
      <tr class="bg-slate-100 font-extrabold text-slate-900">
        <td colspan="2" class="py-3 px-4 text-right text-sm">รวมจำนวนสั่งซื้อทั้งสิ้น</td>
        <td class="py-3 px-4 text-center font-mono text-base text-indigo-700">${totalBoxes.toLocaleString('th-TH')} ลัง</td>
      </tr>
    `;
  } else {
    // Internal Analysis Mode: Shows cost, retail price, profit per piece, and total projected profit
    stripEl.className = 'grid grid-cols-3 gap-3 text-center';
    stripEl.innerHTML = `
      <div class="bg-rose-50 border border-rose-300 rounded-xl p-3">
        <span class="text-[11px] text-rose-700 font-bold block">ต้นทุนสั่งซื้อรวม (${totalBoxes} ลัง)</span>
        <span class="text-base sm:text-lg font-extrabold font-mono text-rose-700">฿${totalCost.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</span>
      </div>
      <div class="bg-blue-50 border border-blue-300 rounded-xl p-3">
        <span class="text-[11px] text-blue-700 font-bold block">ยอดขายรวมเมื่อขายหมด (${totalPieces} ชิ้น)</span>
        <span class="text-base sm:text-lg font-extrabold font-mono text-blue-700">฿${totalRevenue.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</span>
      </div>
      <div class="bg-emerald-50 border border-emerald-300 rounded-xl p-3">
        <span class="text-[11px] text-emerald-800 font-bold block">กำไรสุทธิคาดการณ์ทั้งลอต</span>
        <span class="text-base sm:text-lg font-extrabold font-mono text-emerald-700">+฿${totalProfit.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</span>
      </div>
    `;

    theadEl.innerHTML = `
      <tr class="bg-slate-800 text-white text-[11px]">
        <th style="width: 6%;" class="py-2.5 px-1.5 text-center">ลำดับ</th>
        <th style="width: 24%;" class="py-2.5 px-2.5 text-left">รายการสินค้า</th>
        <th style="width: 8%;" class="py-2.5 px-1.5 text-center">ชิ้น/ลัง</th>
        <th style="width: 9%;" class="py-2.5 px-2 text-right">ทุน/ชิ้น</th>
        <th style="width: 9%;" class="py-2.5 px-2 text-right">ขาย/ชิ้น</th>
        <th style="width: 9%;" class="py-2.5 px-2 text-right">กำไร/แท่ง</th>
        <th style="width: 8%;" class="py-2.5 px-1.5 text-center">สั่ง (ลัง)</th>
        <th style="width: 9%;" class="py-2.5 px-2 text-right">ทุนรวม</th>
        <th style="width: 9%;" class="py-2.5 px-2 text-right">ขายรวม</th>
        <th style="width: 9%;" class="py-2.5 px-2 text-right text-emerald-300">กำไรรวม</th>
      </tr>
    `;

    tbodyEl.innerHTML = orderedItems.map((item, idx) => {
      const m = item.metrics;
      const lineCost = m.boxCost * item.orderQty;
      const lineRev = m.boxRevenue * item.orderQty;
      const lineProfit = m.boxProfit * item.orderQty;
      return `
        <tr class="even:bg-slate-50/70">
          <td class="py-2 px-1.5 text-center font-mono">${idx + 1}</td>
          <td class="py-2 px-2.5 font-bold text-slate-800">${escapeHtml(item.name)}</td>
          <td class="py-2 px-1.5 text-center font-mono">${m.pieces}</td>
          <td class="py-2 px-2 text-right font-mono">${m.costPiece.toFixed(2)}</td>
          <td class="py-2 px-2 text-right font-mono font-bold">${m.retailPiece.toFixed(2)}</td>
          <td class="py-2 px-2 text-right font-mono text-emerald-700">+${m.profitPerPiece.toFixed(2)}</td>
          <td class="py-2 px-1.5 text-center font-mono font-bold text-indigo-700">${item.orderQty}</td>
          <td class="py-2 px-2 text-right font-mono text-rose-700">${lineCost.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
          <td class="py-2 px-2 text-right font-mono text-blue-700">${lineRev.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
          <td class="py-2 px-2 text-right font-mono font-bold text-emerald-700">+${lineProfit.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
        </tr>
      `;
    }).join('');

    tfootEl.innerHTML = `
      <tr class="bg-slate-100 font-extrabold text-slate-900">
        <td colspan="6" class="py-2.5 px-3 text-right">รวมทั้งสิ้น (${totalPieces.toLocaleString('th-TH')} ชิ้น)</td>
        <td class="py-2.5 px-1.5 text-center font-mono text-indigo-700">${totalBoxes} ลัง</td>
        <td class="py-2.5 px-2 text-right font-mono text-rose-700">${totalCost.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
        <td class="py-2.5 px-2 text-right font-mono text-blue-700">${totalRevenue.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
        <td class="py-2.5 px-2 text-right font-mono text-emerald-700">+${totalProfit.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
      </tr>
    `;
  }
}

async function downloadPurchaseOrderPDF() {
  const sheetEl = document.getElementById('po-report-sheet');
  const btn = document.getElementById('btn-download-po-pdf');
  if (!sheetEl) return;

  if (typeof window.html2pdf === 'undefined') {
    showToast('กำลังเปิดหน้าต่างบันทึก PDF มาตรฐาน...', 'info');
    window.print();
    return;
  }

  const poNum = document.getElementById('po-sheet-number').innerText || 'PO';
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> กำลังสร้างไฟล์ PDF...';
  }

  try {
    const opt = {
      margin: [10, 10, 10, 10],
      filename: `ใบสั่งซื้อไอศกรีม_${poNum}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, logging: false },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };
    await window.html2pdf().set(opt).from(sheetEl).save();
    showToast(`ดาวน์โหลดไฟล์ "ใบสั่งซื้อไอศกรีม_${poNum}.pdf" สำเร็จแล้ว!`, 'success');
  } catch (err) {
    console.error('PDF export error:', err);
    window.print();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }
}

async function applyPOAsActiveLotCost() {
  if (!activeLot) {
    showToast('ไม่พบลอตปัจจุบันที่เปิดอยู่', 'error');
    return;
  }

  let totalCost = 0;
  for (const p of productCatalog) {
    const qty = parseInt(orderDraftQuantities[p.id] || 0, 10);
    if (qty > 0) {
      totalCost += computeProductMetrics(p).boxCost * qty;
    }
  }

  if (totalCost <= 0) {
    showToast('กรุณาเลือกจำนวนลังสินค้าอย่างน้อย 1 ลังก่อนตั้งเป็นต้นทุนลอต', 'warning');
    return;
  }

  if (!confirm(`ต้องการนำยอดรวมใบสั่งซื้อ ฿${totalCost.toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท ไปตั้งเป็นต้นทุนของลอตปัจจุบันใช่หรือไม่?`)) {
    return;
  }

  const floatAmt = activeLot.float_money !== undefined ? parseFloat(activeLot.float_money) : 500;
  const ok = await updateActiveLotCostAndFloat(activeLot.id, totalCost, floatAmt);
  if (ok) {
    closeModal('po-report-modal');
    await loadActiveLotData();
    showToast(`ตั้งค่าต้นทุนลอตปัจจุบันเป็น ฿${totalCost.toLocaleString('th-TH')} บาท ตามใบสั่งซื้อเรียบร้อย!`, 'success');
  }
}

function toggleA4SignatureAndDate(show) {
  const dateEl = document.getElementById('a4-report-printed-date');
  const signBlock = document.getElementById('a4-signature-block');
  if (dateEl) dateEl.classList.toggle('hidden', !show);
  if (signBlock) signBlock.classList.toggle('hidden', !show);
}

function togglePOSignatureAndDate(show) {
  const dateRow = document.getElementById('po-date-row');
  const buyerEl = document.getElementById('po-sheet-buyer');
  const signBlock = document.getElementById('po-signature-block');
  if (dateRow) dateRow.classList.toggle('hidden', !show);
  if (buyerEl) buyerEl.classList.toggle('hidden', !show);
  if (signBlock) signBlock.classList.toggle('hidden', !show);
}

// --- Wall's Brand Flavor Packaging Badges & Chime Bell Synthesizer ---
function getWallsFlavorBadge(prod) {
  const name = (prod.name || '').toLowerCase();
  const cat = prod.category || 'ทั่วไป';

  if (name.includes('คอร์เนตโต') || name.includes('cornetto')) {
    return `<span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-0.5 rounded-full bg-gradient-to-r from-rose-600 to-blue-700 text-white font-bold shadow-xs">🍦 Cornetto โคนกรอบช็อกปลายโคน</span>`;
  }
  if (name.includes('แพดเดิลป๊อป') || name.includes('paddle')) {
    return `<span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-0.5 rounded-full bg-gradient-to-r from-pink-500 via-amber-400 to-sky-500 text-white font-extrabold shadow-xs">🦁🌈 Paddle Pop สิงโตแม็กซ์</span>`;
  }
  if (name.includes('แม็กนั่ม') || name.includes('magnum')) {
    return `<span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-0.5 rounded-full bg-gradient-to-r from-amber-900 via-yellow-800 to-amber-600 text-amber-100 font-bold border border-amber-400/50 shadow-xs">🍫✨ Magnum ช็อกเบลเยียม</span>`;
  }
  if (name.includes('คาลิปโป') || name.includes('calippo')) {
    return `<span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-0.5 rounded-full bg-gradient-to-r from-lime-500 to-emerald-600 text-white font-bold shadow-xs">🍋🧊 Calippo หลอดบีบชื่นใจ</span>`;
  }
  if (name.includes('เอเชียน') || name.includes('กะทิ')) {
    return `<span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300 font-bold">🥥🌿 Asian Delight กะทิแท้</span>`;
  }
  if (name.includes('ท็อปเท็น') || name.includes('top ten')) {
    return `<span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-300 font-bold">🥜🍫 Top Ten เคลือบช็อกถั่ว</span>`;
  }
  if (cat === 'ถ้วย' || name.includes('ถ้วย')) {
    return `<span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-0.5 rounded-full bg-pink-100 text-pink-700 border border-pink-200 font-bold">🍨🍓 Wall's Cup ไอศกรีมถ้วย</span>`;
  }
  if (cat === 'แซนด์วิช/อื่นๆ' || name.includes('แซนด์วิช')) {
    return `<span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-0.5 rounded-full bg-orange-100 text-orange-800 border border-orange-200 font-bold">🥪🍦 Wall's Sandwich</span>`;
  }

  const fallbackIcons = { 'โคน': '🍦', 'แท่ง': '🍭', 'ถ้วย': '🍨', 'แซนด์วิช/อื่นๆ': '🥪' };
  return `<span class="inline-block text-[10px] px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 font-bold">${fallbackIcons[cat] || '🍦'} ${escapeHtml(cat)}</span>`;
}

let wallsSoundEnabled = localStorage.getItem('walls_sound_enabled') !== 'false';

function toggleWallsSound() {
  wallsSoundEnabled = !wallsSoundEnabled;
  localStorage.setItem('walls_sound_enabled', wallsSoundEnabled ? 'true' : 'false');

  const iconEl = document.getElementById('sound-toggle-icon');
  const textEl = document.getElementById('sound-toggle-text');
  const btnEl = document.getElementById('btn-sound-toggle');

  if (wallsSoundEnabled) {
    if (iconEl) iconEl.className = 'fa-solid fa-bell walls-bell-anim';
    if (textEl) textEl.innerText = 'เสียงกริ๊ง';
    if (btnEl) btnEl.className = 'flex items-center space-x-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-white/15 hover:bg-white/25 text-amber-200 border border-white/25 transition cursor-pointer whitespace-nowrap shrink-0';
    playWallsChime('success');
    showToast('🔔 เปิดเสียงกระดิ่งรถไอติมวอลล์แล้ว!', 'info');
  } else {
    if (iconEl) iconEl.className = 'fa-solid fa-bell-slash opacity-70';
    if (textEl) textEl.innerText = 'ปิดเสียง';
    if (btnEl) btnEl.className = 'flex items-center space-x-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/10 hover:bg-white/20 text-white/80 border border-white/20 transition cursor-pointer whitespace-nowrap shrink-0';
    showToast('🔕 ปิดเสียงกระดิ่งเรียบร้อย', 'info');
  }
}

function playWallsChime(type = 'success') {
  if (!wallsSoundEnabled) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    if (type === 'tap') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.09);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.09);
      return;
    }

    // Wall's Cheerful 4-Note Ice Cream Chime Melody (E5 -> G5 -> C6 -> E6)
    const notes = [659.25, 783.99, 1046.50, 1318.51];
    notes.forEach((freq, i) => {
      const start = ctx.currentTime + i * 0.11;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.14, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.32);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.32);
    });
  } catch (e) {}
}

// ========================================================
// 7. Utility Functions
// ========================================================
function generateUUID() {
  if (crypto && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  const bgColors = {
    success: 'bg-emerald-600 text-white',
    error: 'bg-rose-600 text-white',
    warning: 'bg-amber-500 text-slate-900 font-bold',
    info: 'bg-slate-800 text-white'
  };

  const icons = {
    success: 'fa-circle-check',
    error: 'fa-circle-exclamation',
    warning: 'fa-triangle-exclamation',
    info: 'fa-circle-info'
  };

  toast.className = `${bgColors[type] || bgColors.info} px-4 py-3 rounded-2xl shadow-xl flex items-center space-x-2.5 text-xs transition-all transform duration-300 -translate-y-2 opacity-0 pointer-events-auto border border-white/10`;
  toast.innerHTML = `
    <i class="fa-solid ${icons[type] || icons.info} text-base"></i>
    <span class="flex-1 font-medium">${message}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.remove('-translate-y-2', 'opacity-0');
  }, 10);

  setTimeout(() => {
    toast.classList.add('opacity-0', '-translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}
