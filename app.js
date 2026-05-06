/* ============================================
   东方财富板块竞价实时监控系统 - 核心逻辑
   数据来源：本地 Python 服务（http://localhost:8080）
   功能：竞价数据采集触发、历史对比、实时刷新、按日期查询
   ============================================ */

// ========== 配置 ==========
const CONFIG = {
    API_BASE: 'http://localhost:8080',
    PAGE_SIZE: 20,
};

// 板块类型配置
const SECTOR_TYPES = {
    industry: { name: '行业板块', fs: 'm:90+t:2' },
    concept:  { name: '概念板块', fs: 'm:90+t:3' },
};

// ========== 全局状态 ==========
const state = {
    currentType: 'industry',
    data: [],
    filteredData: [],
    currentPage: 1,
    sortField: '_auctionAmount',
    sortAsc: false,
    searchTerm: '',
    autoRefreshTimer: null,
    isLoading: false,
    lastUpdateTime: null,
    // 竞价数据
    auctionData: null,
    prevAuctionData: null,
    captureStatus: 'idle',
    // 日期查询
    queryDate: null,       // null=今天实时, 'YYYYMMDD'=历史日期
    isHistoryMode: false,  // 是否在查看历史数据
    // A股总数
    totalStockCount: null,
};

// ========== 字段映射 & 格式化 ==========
const FIELD_META = {
    f2:   { label: '最新价',     fmt: v => fmtNum(v, 2) },
    f3:   { label: '涨跌幅',     fmt: v => fmtPct(v) },
    f4:   { label: '涨跌额',     fmt: v => fmtNum(v, 2) },
    f5:   { label: '总手',       fmt: v => fmtVolume(v) },
    f6:   { label: '成交额',     fmt: v => fmtAmount(v) },
    f8:   { label: '换手率',     fmt: v => fmtPct(v) },
    f12:  { label: '板块代码',   fmt: v => v || '--' },
    f14:  { label: '板块名称',   fmt: v => v || '--' },
    f62:  { label: '主力净流入', fmt: v => fmtMoney(v) },
    f184: { label: '主力净占比', fmt: v => fmtPct(v) },
    f66:  { label: '超大单净额', fmt: v => fmtMoney(v) },
    f69:  { label: '超大单占比', fmt: v => fmtPct(v) },
    f72:  { label: '大单净额',   fmt: v => fmtMoney(v) },
    f75:  { label: '大单占比',   fmt: v => fmtPct(v) },
    f78:  { label: '中单净额',   fmt: v => fmtMoney(v) },
    f81:  { label: '中单占比',   fmt: v => fmtPct(v) },
    f84:  { label: '小单净额',   fmt: v => fmtMoney(v) },
    f87:  { label: '小单占比',   fmt: v => fmtPct(v) },
    f104: { label: '上涨家数',   fmt: v => v != null ? v : '--' },
    f105: { label: '下跌家数',   fmt: v => v != null ? v : '--' },
    f106: { label: '平盘家数',   fmt: v => v != null ? v : '--' },
    f128: { label: '领涨股',     fmt: v => v || '--' },
    f136: { label: '领涨股代码', fmt: v => v || '--' },
};

// ========== 格式化工具 ==========
function fmtNum(v, d) {
    return v != null ? Number(v).toFixed(d) : '--';
}

function fmtPct(v) {
    return v != null ? Number(v).toFixed(2) + '%' : '--';
}

function fmtVolume(v) {
    if (v == null || v === '' || v === '-') return '--';
    v = parseFloat(v);
    if (isNaN(v)) return '--';
    if (Math.abs(v) >= 10000) return (v / 10000).toFixed(2) + '万手';
    return v.toFixed(0) + '手';
}

function fmtAmount(v) {
    if (v == null || v === '' || v === '-') return '--';
    v = parseFloat(v);
    if (isNaN(v)) return '--';
    const abs = Math.abs(v);
    if (abs >= 100000000) return (v / 100000000).toFixed(2) + '亿';
    if (abs >= 10000) return (v / 10000).toFixed(2) + '万';
    return v.toFixed(2);
}

function fmtMoney(v) {
    if (v == null || v === '' || v === '-') return '--';
    v = parseFloat(v);
    if (isNaN(v)) return '--';
    const abs = Math.abs(v);
    let s;
    if (abs >= 100000000) s = (v / 100000000).toFixed(2) + '亿';
    else if (abs >= 10000) s = (v / 10000).toFixed(2) + '万';
    else s = v.toFixed(2);
    return (v > 0 ? '+' : '') + s;
}

function getChangeClass(v) {
    if (v == null || v === '' || v === '-') return '';
    v = parseFloat(v);
    if (isNaN(v)) return '';
    if (v > 0) return 'up';
    if (v < 0) return 'down';
    return '';
}

// ========== 交易时段判断 ==========
function getTradingPeriod() {
    const now = new Date();
    const day = now.getDay();
    const h = now.getHours();
    const m = now.getMinutes();
    const t = h * 100 + m;

    if (day === 0 || day === 6) return 'closed';
    if (t >= 915 && t < 925) return 'auction';
    if (t >= 925 && t < 930) return 'auction-end';
    if ((t >= 930 && t < 1130) || (t >= 1300 && t < 1500)) return 'trading';
    if (t >= 1130 && t < 1300) return 'break';
    if (t >= 1500 && t < 1600) return 'after';
    return 'closed';
}

// ========== API 请求 ==========
async function apiFetch(path, options) {
    const url = CONFIG.API_BASE + path;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30秒超时
    try {
        const resp = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeout);
        if (!resp.ok) {
            throw new Error(`服务返回错误: HTTP ${resp.status}`);
        }
        return resp.json();
    } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
            throw new Error('请求超时（30秒），请检查网络或服务状态');
        }
        throw err;
    }
}

// ========== A股总数 ==========
async function loadStockCount() {
    try {
        const data = await apiFetch('/api/stock-count');
        if (data.success && data.total) {
            state.totalStockCount = data.total;
            const el = document.getElementById('totalStocks');
            if (el) el.textContent = data.total.toLocaleString();
        }
    } catch (err) {
        console.warn('[loadStockCount] 获取A股总数失败:', err);
    }
}

// ========== 可用日期列表 ==========
async function loadAvailableDates() {
    try {
        const data = await apiFetch('/api/dates');
        if (data.success && data.dates && data.dates.length > 0) {
            const dateLabel = document.querySelector('.date-label');
            if (dateLabel) {
                const dates = data.dates.slice(0, 5).join('、');
                dateLabel.title = `已有数据的日期: ${data.dates.join('、')}`;
                dateLabel.textContent = `📅 日期（有数据: ${data.dates.length}天）`;
            }
        }
    } catch (err) {
        console.warn('[loadAvailableDates] 获取日期列表失败:', err);
    }
}

// ========== 竞价数据采集 ==========
async function captureAuction() {
    if (state.captureStatus === 'capturing') return;

    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    const t = h * 100 + m;
    const day = now.getDay();
    const isWeekday = day >= 1 && day <= 5;
    const isAuctionTime = t >= 915 && t <= 930;

    if (!isWeekday) {
        const msg = `⚠️ 当前是周末，采集到的数据可能不是交易日数据，确认要继续采集吗？`;
        if (!confirm(msg)) return;
    } else if (!isAuctionTime) {
        const msg = `💡 当前时间（${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}）不在竞价时段（9:15~9:30），` +
            `采集到的成交额为全天累计成交额。竞价时段采集则为竞价额。\n\n确认要继续采集吗？`;
        if (!confirm(msg)) return;
    }

    const statusEl = document.getElementById('captureStatus');
    state.captureStatus = 'capturing';
    statusEl.textContent = '正在采集数据，请稍候...';
    statusEl.className = 'capture-status';

    const btn = document.getElementById('btnCapture');
    btn.classList.add('capturing');
    btn.disabled = true;

    try {
        const result = await apiFetch('/api/fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });

        if (!result.success) {
            throw new Error(result.message || '采集启动失败');
        }

        const taskId = result.task_id;
        let done = false;
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const status = await apiFetch(`/api/fetch/status/${taskId}`);
            if (status.success && status.status === 'done') {
                done = true;
                if (status.returncode === 0) {
                    statusEl.textContent = '采集成功！数据已保存。';
                    statusEl.className = 'capture-status success';
                    state.captureStatus = 'done';
                    await loadAuctionData();
                } else {
                    statusEl.textContent = '采集失败：' + (status.stderr || status.error || '未知错误');
                    statusEl.className = 'capture-status error';
                    state.captureStatus = 'error';
                }
                break;
            }
        }

        if (!done) {
            statusEl.textContent = '采集超时，请检查服务状态';
            statusEl.className = 'capture-status error';
            state.captureStatus = 'error';
        }
    } catch (err) {
        statusEl.textContent = '采集失败：' + err.message;
        statusEl.className = 'capture-status error';
        state.captureStatus = 'error';
        console.error('[captureAuction]', err);
    } finally {
        btn.classList.remove('capturing');
        btn.disabled = false;
    }
}

// ========== 加载竞价快照数据 ==========
async function loadAuctionData() {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    try {
        const todayData = await apiFetch(`/api/snapshot/latest?date=${today}`);
        if (todayData.success) {
            state.auctionData = todayData;
            if (todayData._prev_data) {
                state.prevAuctionData = todayData._prev_data;
            }
            updateAuctionInfo(todayData);
        }

        mergeAuctionData();
        return !!todayData.success;
    } catch (err) {
        console.error('[loadAuctionData]', err);
        return false;
    }
}

// ========== 合并竞价数据到板块数据 ==========
function mergeAuctionData() {
    if (!state.auctionData || !state.auctionData.data) return;

    const currentType = state.currentType;
    const currentSnapshot = state.auctionData.data[currentType];
    const prevSnapshot = state.prevAuctionData ? state.prevAuctionData.data[currentType] : null;

    const prevMap = {};
    if (prevSnapshot && prevSnapshot.sectors) {
        prevSnapshot.sectors.forEach(s => {
            prevMap[s.f12] = s;
        });
    }

    if (currentSnapshot && currentSnapshot.sectors) {
        state.data = currentSnapshot.sectors.map(s => {
            const prev = prevMap[s.f12];
            const curAmount = parseFloat(s.f6) || 0;
            const prevAmount = prev ? (parseFloat(prev.f6) || 0) : null;

            let change = null;
            let changeRate = null;
            if (prevAmount !== null) {
                change = curAmount - prevAmount;
                changeRate = prevAmount !== 0 ? (change / prevAmount) * 100 : 0;
            }

            return {
                ...s,
                _auctionAmount: curAmount,
                _prevAuctionAmount: prevAmount,
                _auctionChange: change,
                _auctionChangeRate: changeRate,
                _constituentCount: _calcConstituentCount(s),
            };
        });
    }

    updateStats();
    renderTable();
}

/**
 * 计算板块成分股数
 * 优先使用 _constituentTotal（后端已查询），否则用 f104+f105+f106（涨+跌+平=总数）
 * f104/f105/f106 在交易时段准确反映成分股数，盘后展示上一交易日数据
 */
function _calcConstituentCount(item) {
    // 如果后端已经查询了真实成分股总数
    if (item._constituentTotal != null && item._constituentTotal > 0) {
        return item._constituentTotal;
    }
    // 用 f104+f105+f106 估算（上涨+下跌+平盘 = 成分股总数）
    const f104 = item.f104 || 0;
    const f105 = item.f105 || 0;
    const f106 = item.f106 || 0;
    const sum = f104 + f105 + f106;
    return sum > 0 ? sum : null;
}

// ========== 更新竞价信息显示 ==========
function updateAuctionInfo(data) {
    const infoEl = document.getElementById('auctionInfo');
    if (!infoEl || !data) return;

    const captureTime = data.capture_time || '';
    const date = data.date || '';
    let text = `今日快照：${date} ${captureTime}`;
    let cls = '';

    if (data.is_auction_data === true) {
        text += ' ✅ 竞价时段数据';
        cls = 'success';
    } else if (data.is_auction_data === false) {
        text += ' 📊 全天成交额数据';
        cls = '';
    }
    infoEl.textContent = text;
    infoEl.className = 'auction-info ' + cls;
}

// ========== 数据处理 ==========
function processData(raw) {
    if (!raw || !raw.data || !raw.data.diff) return [];
    return raw.data.diff.map((item, idx) => ({
        ...item,
        _index: idx + 1,
    }));
}

// 表头排序字段名映射
const SORT_FIELD_MAP = {
    index:             '_index',
    f14:              'f14',
    auctionAmount:     '_auctionAmount',
    auctionAmountPrev: '_prevAuctionAmount',
    auctionChange:     '_auctionChange',
    auctionChangeRate: '_auctionChangeRate',
    constituentCount:  '_constituentCount',
    f2:  'f2',  f3:  'f3',  f4:  'f4',
    f5:  'f5',  f6:  'f6',  f8:  'f8',
    f62: 'f62', f66: 'f66', f72: 'f72',
    f78: 'f78', f84: 'f84',
    f184:'f184', f128:'f128', f136:'f136',
    f104:'f104', f105:'f105', f106:'f106',
};

// ========== 排序 & 筛选 ==========
function applySortAndFilter() {
    let data = [...state.data];

    if (state.searchTerm) {
        const term = state.searchTerm.toLowerCase();
        data = data.filter(d =>
            (d.f14 && d.f14.toLowerCase().includes(term)) ||
            (d.f12 && d.f12.toLowerCase().includes(term))
        );
    }

    state.filteredData = data;

    const rawField = state.sortField;
    const field = SORT_FIELD_MAP[rawField] || rawField;
    const asc = state.sortAsc;
    data.sort((a, b) => {
        let va = a[field], vb = b[field];
        va = va != null ? parseFloat(va) : -Infinity;
        vb = vb != null ? parseFloat(vb) : -Infinity;
        if (isNaN(va)) va = -Infinity;
        if (isNaN(vb)) vb = -Infinity;
        return asc ? va - vb : vb - va;
    });

    return data;
}

// ========== 渲染统计概览 ==========
function updateStats() {
    const data = state.data;
    if (!data.length) return;

    const up = data.filter(d => parseFloat(d.f3) > 0).length;
    const down = data.filter(d => parseFloat(d.f3) < 0).length;
    const avg = data.reduce((s, d) => s + (parseFloat(d.f3) || 0), 0) / data.length;
    const totalInflow = data.reduce((s, d) => s + (parseFloat(d.f62) || 0), 0);

    document.getElementById('totalCount').textContent = data.length;

    // A股总数（从东方财富API获取的真实值，独立于板块数据）
    if (state.totalStockCount != null) {
        document.getElementById('totalStocks').textContent = state.totalStockCount.toLocaleString();
    }

    document.getElementById('upCount').textContent = up;
    document.getElementById('downCount').textContent = down;

    const avgEl = document.getElementById('avgChange');
    avgEl.textContent = (avg >= 0 ? '+' : '') + avg.toFixed(2) + '%';
    avgEl.className = 'stat-value ' + getChangeClass(avg);

    const inflowEl = document.getElementById('totalInflow');
    inflowEl.textContent = (totalInflow >= 0 ? '+' : '') + (totalInflow / 100000000).toFixed(2) + '亿';
    inflowEl.className = 'stat-value ' + getChangeClass(totalInflow);

    const auctionChangeEl = document.getElementById('auctionTotalChange');
    if (auctionChangeEl) {
        const totalCur = data.reduce((s, d) => s + (parseFloat(d._auctionAmount) || 0), 0);
        const totalPrev = data.reduce((s, d) => s + (parseFloat(d._prevAuctionAmount) || 0), 0);
        const hasPrevData = data.some(d => d._prevAuctionAmount != null);
        if (hasPrevData && totalPrev > 0) {
            const change = totalCur - totalPrev;
            const rate = (change / totalPrev * 100).toFixed(2);
            auctionChangeEl.textContent = (change >= 0 ? '+' : '') + (change / 100000000).toFixed(2) + '亿 (' + (change >= 0 ? '+' : '') + rate + '%)';
            auctionChangeEl.className = 'stat-value ' + getChangeClass(change);
        } else {
            auctionChangeEl.textContent = hasPrevData ? '对比数据为0' : '加载昨日数据中...';
            auctionChangeEl.className = 'stat-value';
        }
    }

    if (state.lastUpdateTime) {
        const t = state.lastUpdateTime;
        document.getElementById('lastUpdate').textContent =
            '最后更新: ' + t.getHours().toString().padStart(2, '0') + ':' +
            t.getMinutes().toString().padStart(2, '0') + ':' +
            t.getSeconds().toString().padStart(2, '0');
    }
}

// ========== 渲染表格 ==========
function renderTable() {
    const sorted = applySortAndFilter();
    const start = (state.currentPage - 1) * CONFIG.PAGE_SIZE;
    const pageData = sorted.slice(start, start + CONFIG.PAGE_SIZE);

    const tbody = document.getElementById('tableBody');
    const isHistoryMode = state.isHistoryMode && state.data.some(d => d._historyMode);

    if (!pageData.length) {
        tbody.innerHTML = '<tr><td colspan="20" style="text-align:center;color:#999;padding:60px 0;font-size:14px;">暂无匹配数据</td></tr>';
        updatePagination(0);
        return;
    }

    let html = '';
    pageData.forEach((item, idx) => {
        const f3Cls = getChangeClass(item.f3);

        // 竞价变化率样式
        let auctionRateTag = '';
        if (item._auctionChangeRate != null) {
            const rateVal = parseFloat(item._auctionChangeRate);
            const auctionRateCls = rateVal >= 0 ? 'auction-change-up' : 'auction-change-down';
            const rate = isNaN(rateVal) ? '--' : rateVal.toFixed(2);
            auctionRateTag = `<span class="change-rate-tag ${auctionRateCls}">${rate}%</span>`;
        } else {
            auctionRateTag = '<span class="auction-change-none">--</span>';
        }

        // 竞价变化额
        let auctionChangeStr = '--';
        let auctionChangeCls = '';
        if (item._auctionChange != null) {
            const changeVal = parseFloat(item._auctionChange);
            if (!isNaN(changeVal)) {
                auctionChangeStr = fmtAmount(Math.abs(changeVal));
                if (changeVal > 0) auctionChangeStr = '+' + auctionChangeStr;
                else if (changeVal < 0) auctionChangeStr = '-' + auctionChangeStr;
                auctionChangeCls = getChangeClass(changeVal);
            }
        }

        // 涨跌幅条宽度
        const f3Val = parseFloat(item.f3) || 0;
        const barW = Math.min(Math.abs(f3Val) * 5, 100);

        // 成分股数量显示
        const cc = item._constituentCount;
        let constituentHtml;
        if (cc != null && cc > 0) {
            constituentHtml = `<span class="constituent-count-btn" data-code="${item.f12}" data-name="${item.f14 || ''}" title="点击查看成分股列表">${cc}</span>`;
        } else {
            constituentHtml = `<span class="constituent-count-btn" data-code="${item.f12}" data-name="${item.f14 || ''}" title="点击查看成分股列表">?</span>`;
        }

        // 历史K线模式下，资金流向/领涨股等不可用
        const na = isHistoryMode ? '<span class="history-na">--</span>' : null;

        // 成交额：历史模式用K线的f6（全天成交额），实时模式也用f6
        const amountDisplay = item.f6 != null ? fmtAmount(item.f6) : '--';
        const amountCls = item._auctionAmount != null ? getChangeClass(item._auctionAmount) : (item.f6 != null ? getChangeClass(item.f6) : '');

        html += `<tr${item._fetch_failed ? ' style="opacity:0.5"' : ''}>
            <td style="text-align:center">${start + idx + 1}</td>
            <td class="td-name">
                <span class="sector-name" data-code="${item.f12}">${item.f14 || '--'}</span>
                <span class="sector-code">${item.f12 || '--'}</span>
            </td>
            <td class="constituent-col">${constituentHtml}</td>
            <td class="auction-col ${item._auctionAmount != null ? getChangeClass(item._auctionAmount) : ''}">${item._auctionAmount != null ? fmtAmount(item._auctionAmount) : '--'}</td>
            <td class="auction-col">${item._prevAuctionAmount != null ? fmtAmount(item._prevAuctionAmount) : '--'}</td>
            <td class="auction-col ${auctionChangeCls}">${auctionChangeStr}</td>
            <td class="auction-col">${auctionRateTag}</td>
            <td>${FIELD_META.f2.fmt(item.f2)}</td>
            <td class="${f3Cls}">
                <div class="change-cell">
                    <span>${FIELD_META.f3.fmt(item.f3)}</span>
                    <div class="change-bar"><div class="change-bar-fill ${f3Cls}" style="width:${barW}%"></div></div>
                </div>
            </td>
            <td class="${f3Cls}">${FIELD_META.f4.fmt(item.f4)}</td>
            <td class="${isHistoryMode ? '' : getChangeClass(item.f62)}">${na || FIELD_META.f62.fmt(item.f62)}</td>
            <td class="${isHistoryMode ? '' : getChangeClass(item.f184)}">${na || FIELD_META.f184.fmt(item.f184)}</td>
            <td class="${isHistoryMode ? '' : getChangeClass(item.f66)}">${na || FIELD_META.f66.fmt(item.f66)}</td>
            <td class="${isHistoryMode ? '' : getChangeClass(item.f72)}">${na || FIELD_META.f72.fmt(item.f72)}</td>
            <td class="${isHistoryMode ? '' : getChangeClass(item.f78)}">${na || FIELD_META.f78.fmt(item.f78)}</td>
            <td class="${isHistoryMode ? '' : getChangeClass(item.f84)}">${na || FIELD_META.f84.fmt(item.f84)}</td>
            <td>${FIELD_META.f5.fmt(item.f5)}</td>
            <td class="${amountCls}">${amountDisplay}</td>
            <td>${FIELD_META.f8.fmt(item.f8)}</td>
            <td class="td-leader">${na || `<span class="leader-tag" title="${item.f128 || ''}">${item.f128 || '--'}</span>`}</td>
        </tr>`;
    });

    tbody.innerHTML = html;
    updatePagination(state.filteredData.length);

    // 绑定板块名称点击事件
    tbody.querySelectorAll('.sector-name').forEach(el => {
        el.addEventListener('click', () => {
            const code = el.dataset.code;
            const item = state.data.find(d => d.f12 === code);
            if (item) openModal(item);
        });
    });

    // 绑定成分股数量点击事件
    tbody.querySelectorAll('.constituent-count-btn').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const code = el.dataset.code;
            const name = el.dataset.name;
            openConstituentsModal(code, name);
        });
    });
}

// ========== 分页 ==========
function updatePagination(total) {
    const pages = Math.ceil(total / CONFIG.PAGE_SIZE) || 1;
    const cur = Math.min(state.currentPage, pages);
    state.currentPage = cur;

    const container = document.getElementById('pagination');
    let html = '';

    html += `<button class="page-btn" onclick="goPage(1)" ${cur <= 1 ? 'disabled' : ''}>首页</button>`;
    html += `<button class="page-btn" onclick="goPage(${cur - 1})" ${cur <= 1 ? 'disabled' : ''}>&lt;</button>`;

    const s = Math.max(1, cur - 3);
    const e = Math.min(pages, cur + 3);
    for (let i = s; i <= e; i++) {
        html += `<button class="page-btn ${i === cur ? 'active' : ''}" onclick="goPage(${i})">${i}</button>`;
    }

    html += `<button class="page-btn" onclick="goPage(${cur + 1})" ${cur >= pages ? 'disabled' : ''}>&gt;</button>`;
    html += `<button class="page-btn" onclick="goPage(${pages})" ${cur >= pages ? 'disabled' : ''}>末页</button>`;
    html += `<span class="page-info">共 ${total} 条 / ${pages} 页</span>`;

    container.innerHTML = html;
}

function goPage(p) {
    const pages = Math.ceil(state.filteredData.length / CONFIG.PAGE_SIZE) || 1;
    if (p < 1 || p > pages) return;
    state.currentPage = p;
    renderTable();
    document.getElementById('tableContainer')?.scrollTo({ top: 0, behavior: 'smooth' });
}

// ========== 时钟 & 交易状态 ==========
function updateClock() {
    const now = new Date();
    const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map(n => String(n).padStart(2, '0')).join(':');
    document.getElementById('clock').textContent = ts;

    const period = getTradingPeriod();
    const dot = document.querySelector('#tradingStatus .status-dot');
    const txt = document.querySelector('#tradingStatus .status-text');

    const map = {
        auction:      ['pre',    '集合竞价中'],
        'auction-end':['active', '竞价结束'],
        trading:      ['active', '交易中'],
        break:        ['',       '午休中'],
        after:        ['',       '盘后'],
        closed:       ['',       '休市'],
    };
    const [cls, label] = map[period] || map.closed;
    dot.className = 'status-dot ' + cls;
    txt.textContent = label;

    if (period === 'auction-end' && state.captureStatus === 'idle') {
        const statusEl = document.getElementById('captureStatus');
        statusEl.textContent = '竞价已结束，可点击"实时采集"按钮采集数据';
        statusEl.className = 'capture-status';
    }
}

// ========== 日期查询 ==========
function backToToday() {
    state.queryDate = null;
    state.isHistoryMode = false;
    document.getElementById('queryDate').value = '';
    document.getElementById('dateQueryBanner').style.display = 'none';
    loadData();
}

async function queryByDate(dateStr) {
    if (!dateStr) return;

    state.queryDate = dateStr.replace(/-/g, '');
    state.isHistoryMode = true;

    // 显示日期查询横幅
    const banner = document.getElementById('dateQueryBanner');
    const text = document.getElementById('dateQueryText');
    text.textContent = `📅 正在加载 ${state.queryDate} 的历史数据...`;
    banner.style.display = 'flex';

    // 停止自动刷新（历史数据不需要）
    stopAutoRefresh();
    document.getElementById('autoRefresh').checked = false;

    if (state.isLoading) return;
    state.isLoading = true;

    const loading = document.getElementById('loading');
    const container = document.getElementById('tableContainer');

    loading.classList.add('show');
    container.style.display = 'none';

    try {
        // 先尝试本地竞价快照
        const snapshotData = await apiFetch(`/api/sector-auction-history?date=${state.queryDate}&type=${state.currentType}`);

        if (snapshotData.success) {
            // 有本地快照，直接使用
            state.data = (snapshotData.sectors || []).map((item, idx) => ({
                ...item,
                _index: idx + 1,
                _auctionAmount: parseFloat(item.f6) || 0,
                _prevAuctionAmount: null,
                _auctionChange: null,
                _auctionChangeRate: null,
                _constituentCount: _calcConstituentCount(item),
                _historyMode: false,
            }));

            state.lastUpdateTime = new Date();
            updateStats();
            renderTable();
            container.style.display = '';
            loading.classList.remove('show');

            const sourceLabel = snapshotData.source === 'local' ? '本地快照' : '东方财富实时';
            const auctionLabel = snapshotData.is_auction_data === true ? '竞价时段' : snapshotData.is_auction_data === false ? '非竞价时段' : '未标记';
            text.textContent = `📅 ${state.queryDate}（${sourceLabel}，${auctionLabel}）`;
            return;
        }

        // 无本地快照，使用K线历史API
        text.textContent = `📅 正在从东方财富获取 ${state.queryDate} 的K线数据（约3~5秒）...`;

        const data = await apiFetch(`/api/sector-history?date=${state.queryDate}&type=${state.currentType}`);
        if (!data.success) {
            throw new Error(data.message || '获取历史数据失败');
        }

        state.data = (data.sectors || []).map((item, idx) => ({
            ...item,
            _index: idx + 1,
            _auctionAmount: parseFloat(item.f6) || 0,
            _prevAuctionAmount: null,
            _auctionChange: null,
            _auctionChangeRate: null,
            _constituentCount: _calcConstituentCount(item),
            _historyMode: true,     // 标记为历史K线模式
        }));

        state.lastUpdateTime = new Date();
        updateStats();
        renderTable();

        container.style.display = '';
        loading.classList.remove('show');

        // 更新横幅文字
        const sourceLabel = data.source === 'local_cache' ? '本地缓存' : '东方财富K线';
        const okCount = data.success_count || 0;
        const failCount = data.fail_count || 0;
        let infoText = `📅 ${state.queryDate}（${sourceLabel}，成功${okCount}个`;
        if (failCount > 0) infoText += `，失败${failCount}个`;
        infoText += '）';
        text.textContent = infoText;
    } catch (err) {
        loading.classList.remove('show');
        state.data = [];
        state.filteredData = [];
        updateStats();
        renderTable();
        container.style.display = '';

        // 区分网络错误和数据错误
        let errMsg = err.message || '未知错误';
        if (err.message === 'Failed to fetch' || err.name === 'TypeError') {
            errMsg = '无法连接到本地服务，请确认 server.py 正在运行（python server.py）';
        }
        text.textContent = `📅 ${state.queryDate} — 加载失败`;
        showError('历史数据加载失败: ' + errMsg);
        console.error('[queryByDate]', err);
    } finally {
        state.isLoading = false;
    }
}

// ========== 加载数据 ==========
async function loadData(silent) {
    if (state.isLoading) return;
    state.isLoading = true;

    const loading = document.getElementById('loading');
    const container = document.getElementById('tableContainer');

    if (!silent) {
        loading.classList.add('show');
        container.style.display = 'none';
    }

    try {
        let hasLocalData = false;
        try {
            hasLocalData = await loadAuctionData();
        } catch (err) {
            console.warn('[loadData] 本地服务不可用，切换到直接API模式');
        }

        if (!hasLocalData) {
            const hasServerData = await loadFromServer();
            if (!hasServerData) {
                await loadFromEastmoneyDirect();
            }
        }

        container.style.display = '';
        loading.classList.remove('show');
    } catch (err) {
        if (!silent) loading.classList.remove('show');
        showError('数据加载失败: ' + err.message);
        console.error('[loadData]', err);
    } finally {
        state.isLoading = false;
    }
}

// 从本地服务API获取所有板块数据
async function loadFromServer() {
    try {
        const data = await apiFetch(`/api/sectors?type=${state.currentType}`);
        if (!data.success || !data.sectors) {
            console.warn('[loadFromServer] 服务器API返回失败，将尝试直接请求');
            return false;
        }

        state.data = data.sectors.map((item, idx) => ({
            ...item,
            _index: idx + 1,
            _auctionAmount: parseFloat(item.f6) || 0,
            _prevAuctionAmount: null,
            _auctionChange: null,
            _auctionChangeRate: null,
            _constituentCount: _calcConstituentCount(item),
        }));

        // 获取昨日对比数据
        await fetchYesterdayComparison();

        state.lastUpdateTime = new Date();
        updateStats();
        renderTable();
        return true;
    } catch (err) {
        console.error('[loadFromServer]', err);
        return false;
    }
}

// ========== 获取昨日成交额对比数据 ==========
async function fetchYesterdayComparison() {
    try {
        const data = await apiFetch(`/api/yesterday-compare?type=${state.currentType}`);
        if (!data.success || !data.amounts) {
            console.warn('[fetchYesterdayComparison] 获取昨日数据失败:', data.message);
            return;
        }

        const prevAmounts = data.amounts;
        const sourceLabel = data.source === 'local_snapshot' ? '本地快照' : data.source === 'kline_cache' ? 'K线缓存' : 'K线实时';

        // 合并昨日数据到当前板块数据
        state.data = state.data.map(item => {
            const code = item.f12;
            const prevAmount = prevAmounts[code] != null ? prevAmounts[code] : null;
            const curAmount = parseFloat(item._auctionAmount) || 0;

            let change = null;
            let changeRate = null;
            if (prevAmount !== null) {
                change = curAmount - prevAmount;
                changeRate = prevAmount !== 0 ? (change / prevAmount) * 100 : 0;
            }

            return {
                ...item,
                _prevAuctionAmount: prevAmount,
                _auctionChange: change,
                _auctionChangeRate: changeRate,
                _yesterdaySource: sourceLabel,
            };
        });

        // 重新渲染
        updateStats();
        renderTable();
    } catch (err) {
        console.error('[fetchYesterdayComparison]', err);
    }
}

// 直接从东方财富API获取数据（备用方案，使用JSONP循环分页）
async function loadFromEastmoneyDirect() {
    const cfg = SECTOR_TYPES[state.currentType];

    // 循环分页获取全量数据
    let allItems = [];
    let page = 1;
    const pageSize = 500;

    while (true) {
        const cbName = '__em_cb_' + (++_jsonpCounter);
        const params = new URLSearchParams({
            pn: String(page), pz: String(pageSize), po: '1', np: '1', fltt: '2', invt: '2', fid: 'f3',
            fs: cfg.fs,
            fields: 'f2,f3,f4,f5,f6,f8,f12,f14,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,f104,f105,f106,f128,f136',
        });

        try {
            const data = await jsonpFetch('https://push2.eastmoney.com/api/qt/clist/get', cbName, params);
            if (!data || !data.data || !data.data.diff) break;

            allItems = allItems.concat(data.data.diff);
            const total = data.data.total || 0;
            if (allItems.length >= total) break;
            page++;
        } catch (err) {
            console.error('[loadFromEastmoneyDirect] JSONP 请求失败:', err);
            break;
        }
    }

    if (allItems.length > 0) {
        state.data = allItems.map((item, idx) => ({
            ...item,
            _index: idx + 1,
            _auctionAmount: parseFloat(item.f6) || 0,
            _prevAuctionAmount: null,
            _auctionChange: null,
            _auctionChangeRate: null,
            _constituentCount: _calcConstituentCount(item),
        }));
        state.lastUpdateTime = new Date();
        updateStats();
        renderTable();

        // 获取昨日对比数据
        await fetchYesterdayComparison();
    }
}

let _jsonpCounter = 0;

function jsonpFetch(url, cbName, params) {
    if (!cbName) cbName = '__em_cb_' + (++_jsonpCounter);
    if (params) params.set('cb', cbName);
    else params = new URLSearchParams({ cb: cbName });

    const fullUrl = url + '?' + params.toString();

    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const timer = setTimeout(() => { cleanup(); reject(new Error('请求超时')); }, 15000);

        window[cbName] = function(data) {
            clearTimeout(timer);
            cleanup();
            resolve(data);
        };

        function cleanup() {
            delete window[cbName];
            script.remove();
        }

        script.src = fullUrl;
        script.onerror = () => { clearTimeout(timer); cleanup(); reject(new Error('网络请求失败')); };
        document.head.appendChild(script);
    });
}

function showError(msg) {
    const toast = document.getElementById('errorToast');
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 8000);
}

// ========== 板块详情弹窗 ==========
function openModal(item) {
    document.getElementById('modalTitle').textContent = `${item.f14}（${item.f12}）`;

    const metrics = [
        ['最新价',     FIELD_META.f2.fmt(item.f2),  ''],
        ['涨跌幅',     FIELD_META.f3.fmt(item.f3),  getChangeClass(item.f3)],
        ['涨跌额',     FIELD_META.f4.fmt(item.f4),  getChangeClass(item.f4)],
        ['竞价成交额', item._auctionAmount != null ? fmtAmount(item._auctionAmount) : '未采集', item._auctionAmount != null ? getChangeClass(item._auctionAmount) : ''],
        ['昨日竞价额', item._prevAuctionAmount != null ? fmtAmount(item._prevAuctionAmount) : '--', ''],
        ['竞价变化率', item._auctionChangeRate != null ? parseFloat(item._auctionChangeRate).toFixed(2) + '%' : '--', getChangeClass(item._auctionChangeRate)],
        ['主力净流入', item._historyMode ? '--' : FIELD_META.f62.fmt(item.f62), item._historyMode ? '' : getChangeClass(item.f62)],
        ['超大单净额', item._historyMode ? '--' : FIELD_META.f66.fmt(item.f66), item._historyMode ? '' : getChangeClass(item.f66)],
        ['大单净额',   item._historyMode ? '--' : FIELD_META.f72.fmt(item.f72), item._historyMode ? '' : getChangeClass(item.f72)],
        ['中单净额',   item._historyMode ? '--' : FIELD_META.f78.fmt(item.f78), item._historyMode ? '' : getChangeClass(item.f78)],
        ['小单净额',   item._historyMode ? '--' : FIELD_META.f84.fmt(item.f84), item._historyMode ? '' : getChangeClass(item.f84)],
        ['换手率',     FIELD_META.f8.fmt(item.f8),   ''],
        ['成交额',     FIELD_META.f6.fmt(item.f6),   ''],
        ['成分股数',   item._constituentCount != null ? item._constituentCount : '--', ''],
        ['上涨家数',   item.f104 != null ? item.f104 : '--', 'up'],
        ['下跌家数',   item.f105 != null ? item.f105 : '--', 'down'],
    ];

    // K线历史数据额外字段
    if (item._historyMode) {
        metrics.splice(7, 5); // 去掉资金流向5项
        metrics.splice(3, 3); // 去掉竞价相关3项
        // 插入K线特有字段
        const klineFields = [
            ['开盘价',  item._open != null ? Number(item._open).toFixed(2) : '--', ''],
            ['最高价',  item._high != null ? Number(item._high).toFixed(2) : '', 'up'],
            ['最低价',  item._low != null ? Number(item._low).toFixed(2) : '', 'down'],
            ['振幅',    item._amplitude != null ? Number(item._amplitude).toFixed(2) + '%' : '--', ''],
        ];
        metrics.splice(3, 0, ...klineFields);
    }

    let cardsHtml = metrics.map(([label, value, cls]) =>
        `<div class="m-card"><span class="m-label">${label}</span><span class="m-value ${cls}">${value}</span></div>`
    ).join('');

    const f62 = item.f62 || 0;
    const f66 = item.f66 || 0;
    const f72 = item.f72 || 0;
    const f78 = item.f78 || 0;
    const f84 = item.f84 || 0;
    const maxAbs = Math.max(Math.abs(f66), Math.abs(f72), Math.abs(f78), Math.abs(f84), 1);

    let flowHtml = `
        <div class="flow-section">
            <h3>资金流向分布</h3>
            <div class="flow-bars">
                <div class="flow-row">
                    <span class="flow-label">超大单</span>
                    <div class="flow-track"><div class="flow-fill ${getChangeClass(f66)}" style="width:${Math.abs(f66)/maxAbs*100}%"></div></div>
                    <span class="flow-val ${getChangeClass(f66)}">${FIELD_META.f66.fmt(f66)}</span>
                </div>
                <div class="flow-row">
                    <span class="flow-label">大单</span>
                    <div class="flow-track"><div class="flow-fill ${getChangeClass(f72)}" style="width:${Math.abs(f72)/maxAbs*100}%"></div></div>
                    <span class="flow-val ${getChangeClass(f72)}">${FIELD_META.f72.fmt(f72)}</span>
                </div>
                <div class="flow-row">
                    <span class="flow-label">中单</span>
                    <div class="flow-track"><div class="flow-fill ${getChangeClass(f78)}" style="width:${Math.abs(f78)/maxAbs*100}%"></div></div>
                    <span class="flow-val ${getChangeClass(f78)}">${FIELD_META.f78.fmt(f78)}</span>
                </div>
                <div class="flow-row">
                    <span class="flow-label">小单</span>
                    <div class="flow-track"><div class="flow-fill ${getChangeClass(f84)}" style="width:${Math.abs(f84)/maxAbs*100}%"></div></div>
                    <span class="flow-val ${getChangeClass(f84)}">${FIELD_META.f84.fmt(f84)}</span>
                </div>
            </div>
        </div>`;

    if (item.f128) {
        flowHtml += `<div class="leader-section"><span class="leader-label">领涨股：</span><span class="up">${item.f128}${item.f136 ? ' (' + item.f136 + ')' : ''}</span></div>`;
    }

    document.getElementById('modalBody').innerHTML =
        `<div class="m-cards">${cardsHtml}</div>${flowHtml}`;

    document.getElementById('modalOverlay').classList.add('show');
}

function closeModal() {
    document.getElementById('modalOverlay').classList.remove('show');
}

// ========== 成分股列表弹窗 ==========

const constituentState = {
    code: '',
    name: '',
    currentPage: 1,
    totalPages: 1,
    total: 0,
    pageSize: 20,
    allStocks: [],       // 全量成分股数据（排序/搜索用）
    sortField: 'change_pct',  // 默认按涨跌幅排序
    sortAsc: false,           // 默认降序（从大到小）
    searchTerm: '',           // 搜索关键词
};

async function openConstituentsModal(code, name) {
    constituentState.code = code;
    constituentState.name = name;
    constituentState.currentPage = 1;
    constituentState.allStocks = [];
    constituentState.sortField = 'change_pct';
    constituentState.sortAsc = false;
    constituentState.searchTerm = '';

    // 清空搜索框
    const searchInput = document.getElementById('constituentsSearchInput');
    if (searchInput) searchInput.value = '';

    document.getElementById('constituentsTitle').textContent = `${name}（${code}）成分股`;
    document.getElementById('constituentsTotalBadge').textContent = '';
    document.getElementById('constituentsLoading').style.display = 'flex';
    document.getElementById('constituentsContent').style.display = 'none';
    document.getElementById('constituentsError').style.display = 'none';
    document.getElementById('constituentsOverlay').classList.add('show');

    // 加载全量成分股数据
    await loadAllConstituents(code);
}

async function loadAllConstituents(code) {
    const pageSize = 500; // 每次请求500条
    let allStocks = [];
    let page = 1;
    let total = 0;

    document.getElementById('constituentsLoading').style.display = 'flex';
    document.getElementById('constituentsContent').style.display = 'none';
    document.getElementById('constituentsError').style.display = 'none';

    try {
        // 循环分页获取全量数据
        while (true) {
            const data = await apiFetch(`/api/constituents?code=${encodeURIComponent(code)}&page=${page}&size=${pageSize}`);
            if (!data.success) {
                throw new Error(data.message || '获取成分股数据失败');
            }

            total = data.total;
            if (data.stocks && data.stocks.length > 0) {
                allStocks = allStocks.concat(data.stocks);
            }

            // 已获取全部数据
            if (allStocks.length >= total || data.stocks.length < pageSize) break;
            page++;
        }

        constituentState.allStocks = allStocks;
        constituentState.total = total;
        constituentState.currentPage = 1;

        document.getElementById('constituentsTotalBadge').textContent = `共 ${total} 只`;

        // 应用排序并渲染
        applyConstituentsSortAndFilter();

        document.getElementById('constituentsLoading').style.display = 'none';
        document.getElementById('constituentsContent').style.display = 'block';
    } catch (err) {
        document.getElementById('constituentsLoading').style.display = 'none';
        const errEl = document.getElementById('constituentsError');
        errEl.textContent = '加载失败：' + err.message;
        errEl.style.display = 'block';
    }
}

function applyConstituentsSortAndFilter() {
    let stocks = [...constituentState.allStocks];

    // 搜索过滤
    if (constituentState.searchTerm) {
        const term = constituentState.searchTerm.toLowerCase();
        stocks = stocks.filter(s =>
            (s.name && s.name.toLowerCase().includes(term)) ||
            (s.code && s.code.toLowerCase().includes(term))
        );
    }

    // 排序
    const field = constituentState.sortField;
    const asc = constituentState.sortAsc;
    stocks.sort((a, b) => {
        let va = parseFloat(a[field]);
        let vb = parseFloat(b[field]);
        if (isNaN(va)) va = -Infinity;
        if (isNaN(vb)) vb = -Infinity;
        return asc ? va - vb : vb - va;
    });

    const pageSize = constituentState.pageSize;
    const total = stocks.length;
    const totalPages = Math.ceil(total / pageSize) || 1;
    const currentPage = Math.min(constituentState.currentPage, totalPages);
    constituentState.currentPage = currentPage;

    const startIdx = (currentPage - 1) * pageSize;
    const pageData = stocks.slice(startIdx, startIdx + pageSize);

    renderConstituentsTable(pageData, currentPage, pageSize);
    renderConstituentsPagination(total, currentPage, totalPages);

    // 更新排序指示
    const indicator = document.getElementById('constituentsSortIndicator');
    if (indicator) {
        const fieldLabels = { change_pct: '涨跌幅', amount: '成交额', price: '最新价', prev_close: '昨收' };
        const label = fieldLabels[field] || field;
        indicator.textContent = `按${label} ${asc ? '↑' : '↓'}`;
    }
}

function goConstituentsPage(p) {
    const totalPages = Math.ceil(constituentState.allStocks.length / constituentState.pageSize) || 1;
    if (p < 1 || p > totalPages) return;
    constituentState.currentPage = p;
    applyConstituentsSortAndFilter();
}

function renderConstituentsTable(stocks, page, pageSize) {
    const tbody = document.getElementById('constituentsTableBody');
    if (!stocks || !stocks.length) {
        const msg = constituentState.searchTerm
            ? `未找到包含"${constituentState.searchTerm}"的股票`
            : '暂无成分股数据';
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#999;padding:40px 0;">${msg}</td></tr>`;
        return;
    }

    const startIdx = (page - 1) * pageSize;
    let html = '';
    stocks.forEach((s, i) => {
        const changeCls = getChangeClass(s.change_pct);
        const amountStr = s.amount != null ? fmtAmount(s.amount) : '--';
        const prevCloseStr = s.prev_close != null ? Number(s.prev_close).toFixed(2) : '--';
        const priceStr = s.price != null ? Number(s.price).toFixed(2) : '--';
        const changePctStr = s.change_pct != null ? Number(s.change_pct).toFixed(2) + '%' : '--';

        html += `<tr>
            <td style="text-align:center;color:#999">${startIdx + i + 1}</td>
            <td class="constituent-stock-name">${s.name}</td>
            <td style="text-align:center;color:#666">${s.code}</td>
            <td class="constituent-amount">${amountStr}</td>
            <td class="constituent-prev-close">${prevCloseStr}</td>
            <td>${priceStr}</td>
            <td class="${changeCls}">${changePctStr}</td>
        </tr>`;
    });

    tbody.innerHTML = html;
}

function renderConstituentsPagination(total, currentPage, totalPages) {
    const container = document.getElementById('constituentsPagination');
    if (totalPages <= 1) {
        container.innerHTML = `<span class="c-page-info">共 ${total} 条</span>`;
        return;
    }

    let html = '';
    html += `<button class="c-page-btn" onclick="goConstituentsPage(1)" ${currentPage <= 1 ? 'disabled' : ''}>首页</button>`;
    html += `<button class="c-page-btn" onclick="goConstituentsPage(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''}>&lt;</button>`;

    const s = Math.max(1, currentPage - 3);
    const e = Math.min(totalPages, currentPage + 3);
    for (let i = s; i <= e; i++) {
        html += `<button class="c-page-btn ${i === currentPage ? 'active' : ''}" onclick="goConstituentsPage(${i})">${i}</button>`;
    }

    html += `<button class="c-page-btn" onclick="goConstituentsPage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''}>&gt;</button>`;
    html += `<button class="c-page-btn" onclick="goConstituentsPage(${totalPages})" ${currentPage >= totalPages ? 'disabled' : ''}>末页</button>`;
    html += `<span class="c-page-info">共 ${total} 条 / ${totalPages} 页</span>`;

    container.innerHTML = html;
}

function closeConstituentsModal() {
    document.getElementById('constituentsOverlay').classList.remove('show');
}

// ========== 历史记录弹窗 ==========
async function openHistory() {
    const overlay = document.getElementById('historyOverlay');
    const body = document.getElementById('historyBody');

    body.innerHTML = '<div style="text-align:center;padding:40px;color:#999;">加载中...</div>';
    overlay.classList.add('show');

    try {
        const dates = await apiFetch('/api/dates');
        if (!dates.success || !dates.dates.length) {
            body.innerHTML = '<div style="text-align:center;padding:40px;color:#999;">暂无历史数据</div>';
            return;
        }

        let html = `<table class="history-table">
            <thead><tr>
                <th>日期</th><th>快照文件</th><th>操作</th>
            </tr></thead><tbody>`;

        for (const dateStr of dates.dates.slice(0, 30)) {
            const data = await apiFetch(`/api/snapshot?date=${dateStr}`);
            if (data.success && data.all_files) {
                for (const file of data.all_files) {
                    html += `<tr>
                        <td>${dateStr}</td>
                        <td>${file}</td>
                        <td><button onclick="loadHistoryFile('${dateStr}', '${file}')" style="padding:4px 12px;border:1px solid #4361ee;background:#fff;color:#4361ee;border-radius:4px;cursor:pointer;">查看</button></td>
                    </tr>`;
                }
            }
        }

        html += '</tbody></table>';
        body.innerHTML = html;
    } catch (err) {
        body.innerHTML = `<div style="text-align:center;padding:40px;color:#c1121f;">加载失败: ${err.message}</div>`;
    }
}

async function loadHistoryFile(dateStr, filename) {
    try {
        const data = await apiFetch(`/api/snapshot?date=${dateStr}`);
        if (data.success) {
            state.auctionData = data;
            mergeAuctionData();
            document.getElementById('historyOverlay').classList.remove('show');
        }
    } catch (err) {
        showError('加载历史数据失败: ' + err.message);
    }
}

function closeHistory() {
    document.getElementById('historyOverlay').classList.remove('show');
}

// ========== 自动刷新 ==========
function startAutoRefresh() {
    stopAutoRefresh();
    const cb = document.getElementById('autoRefresh');
    if (!cb || !cb.checked) return;

    const interval = parseInt(document.getElementById('refreshInterval')?.value) || 5000;
    state.autoRefreshTimer = setInterval(() => loadData(true), interval);
}

function stopAutoRefresh() {
    if (state.autoRefreshTimer) {
        clearInterval(state.autoRefreshTimer);
        state.autoRefreshTimer = null;
    }
}

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', () => {
    // 时钟
    updateClock();
    setInterval(updateClock, 1000);

    // 设置日期选择器默认值
    const queryDateInput = document.getElementById('queryDate');
    const today = new Date();
    queryDateInput.max = today.toISOString().slice(0, 10);

    // 加载已有数据的日期列表，提示用户哪些日期有数据
    loadAvailableDates();

    // 竞价采集按钮
    document.getElementById('btnCapture')?.addEventListener('click', captureAuction);

    // 历史记录按钮
    document.getElementById('btnHistory')?.addEventListener('click', openHistory);
    document.getElementById('historyClose')?.addEventListener('click', closeHistory);
    document.getElementById('historyOverlay')?.addEventListener('click', e => {
        if (e.target === e.currentTarget) closeHistory();
    });

    // 日期查询
    document.getElementById('btnQueryDate')?.addEventListener('click', () => {
        const dateVal = queryDateInput.value;
        if (!dateVal) {
            showError('请先选择一个日期');
            return;
        }
        queryByDate(dateVal);
    });

    document.getElementById('btnToday')?.addEventListener('click', backToToday);

    // 日期输入回车触发查询
    queryDateInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const dateVal = queryDateInput.value;
            if (dateVal) queryByDate(dateVal);
        }
    });

    // Tab 切换
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelector('.tab.active')?.classList.remove('active');
            tab.classList.add('active');
            state.currentType = tab.dataset.type;
            state.currentPage = 1;

            if (state.isHistoryMode && state.queryDate) {
                queryByDate(state.queryDate);
            } else {
                loadData();
            }
        });
    });

    // 搜索
    let searchTimer;
    document.getElementById('searchInput').addEventListener('input', e => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            state.searchTerm = e.target.value.trim();
            state.currentPage = 1;
            renderTable();
        }, 300);
    });

    // 排序下拉
    document.getElementById('sortSelect').addEventListener('change', e => {
        const [field, dir] = e.target.value.split('_');
        state.sortField = field;
        state.sortAsc = dir === 'asc';
        state.currentPage = 1;
        renderTable();
    });

    // 表头排序
    document.querySelectorAll('.data-table thead th.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const field = th.dataset.sort;
            if (!field || field === 'index') return;
            if (state.sortField === field) {
                state.sortAsc = !state.sortAsc;
            } else {
                state.sortField = field;
                state.sortAsc = false;
            }
            state.currentPage = 1;
            document.querySelectorAll('.data-table thead th').forEach(t => t.classList.remove('sort-asc', 'sort-desc'));
            th.classList.add(state.sortAsc ? 'sort-asc' : 'sort-desc');
            renderTable();
        });
    });

    // 自动刷新
    document.getElementById('autoRefresh')?.addEventListener('change', () => {
        document.getElementById('autoRefresh').checked ? startAutoRefresh() : stopAutoRefresh();
    });
    document.getElementById('refreshInterval')?.addEventListener('change', startAutoRefresh);

    // 手动刷新
    document.getElementById('btnRefresh')?.addEventListener('click', () => {
        if (state.isHistoryMode) {
            queryByDate(state.queryDate);
        } else {
            loadData();
        }
    });

    // 弹窗
    document.getElementById('modalClose')?.addEventListener('click', closeModal);
    document.getElementById('modalOverlay')?.addEventListener('click', e => {
        if (e.target === e.currentTarget) closeModal();
    });
    document.getElementById('constituentsClose')?.addEventListener('click', closeConstituentsModal);
    document.getElementById('constituentsOverlay')?.addEventListener('click', e => {
        if (e.target === e.currentTarget) closeConstituentsModal();
    });

    // 成分股搜索框
    document.getElementById('constituentsSearchInput')?.addEventListener('input', e => {
        constituentState.searchTerm = e.target.value.trim();
        constituentState.currentPage = 1;
        applyConstituentsSortAndFilter();
    });

    // 成分股表头排序点击
    document.querySelectorAll('[data-c-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const field = th.dataset.cSort;
            if (constituentState.sortField === field) {
                constituentState.sortAsc = !constituentState.sortAsc;
            } else {
                constituentState.sortField = field;
                constituentState.sortAsc = false;
            }
            constituentState.currentPage = 1;
            applyConstituentsSortAndFilter();

            // 更新排序箭头
            document.querySelectorAll('[data-c-sort]').forEach(h => {
                h.classList.remove('sort-active-asc', 'sort-active-desc');
                const arrow = h.querySelector('.sort-arrow');
                if (arrow) arrow.textContent = '';
            });
            th.classList.add(constituentState.sortAsc ? 'sort-active-asc' : 'sort-active-desc');
            const arrow = th.querySelector('.sort-arrow');
            if (arrow) arrow.textContent = constituentState.sortAsc ? '↑' : '↓';
        });
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeHistory(); closeConstituentsModal(); } });

    // 首次加载：加载数据 + A股总数
    loadData();
    loadStockCount();
    startAutoRefresh();
});
