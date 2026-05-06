"""
Flask 本地服务 - 板块竞价监控系统
功能：
  1. 提供静态文件服务（index.html, style.css, app.js）
  2. POST /api/fetch      - 触发竞价数据采集
  3. GET  /api/dates       - 列出所有历史采集日期
  4. GET  /api/snapshot    - 获取指定日期快照
  5. GET  /api/snapshot/latest - 获取最新快照
  6. GET  /api/sectors     - 获取全量板块列表（循环分页）
  7. GET  /api/stock-count - 获取A股股票总数
  8. GET  /api/constituents - 获取板块成分股列表
  9. GET  /api/sector-history - 获取板块历史K线数据（按日期查询）

运行：python server.py
访问：http://localhost:8080
"""
import json
import subprocess
import threading
import time
from pathlib import Path
from datetime import datetime
from urllib.parse import urlencode as _urlencode
from urllib.request import Request as _Request, urlopen as _urlopen
from concurrent.futures import ThreadPoolExecutor, as_completed

from flask import Flask, jsonify, request, send_from_directory

# ── 配置 ─────────────────────────────────────────────
PORT = 8080
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data" / "auction"
HISTORY_DIR = BASE_DIR / "data" / "history"  # 历史K线数据缓存目录

app = Flask(__name__, static_folder=str(BASE_DIR))

# ── 通用 HTTP 请求工具 ──────────────────────────────────
_EM_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"


def _em_get(url, timeout=15, retries=2):
    """请求东方财富 API，返回解析后的 JSON，带重试"""
    for attempt in range(retries + 1):
        try:
            req = _Request(url, headers={"User-Agent": _EM_UA})
            with _urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            if attempt < retries:
                time.sleep(0.5 * (attempt + 1))  # 递增等待
                continue
            raise
            raise RuntimeError(f"JSON 解析失败: {e}")


# ── 后台采集 ───────────────────────────────────────────
_fetch_results = {}  # task_id -> result


def run_fetch_in_background(task_id, date=None, capture_time=None):
    """后台运行采集脚本"""
    try:
        cmd = [str(Path(BASE_DIR / "fetch_auction.py").resolve())]
        import sys
        cmd = [sys.executable] + cmd
        if date:
            cmd.extend(["--date", date])
        if capture_time:
            cmd.extend(["--time", capture_time])

        result = subprocess.run(
            cmd,
            cwd=str(BASE_DIR),
            capture_output=True,
            text=True,
            timeout=180,
        )

        _fetch_results[task_id] = {
            "status": "done",
            "returncode": result.returncode,
            "stdout": result.stdout[-2000:] if result.stdout else "",
            "stderr": result.stderr[-1000:] if result.stderr else "",
        }
    except Exception as e:
        _fetch_results[task_id] = {
            "status": "done",
            "error": str(e),
        }


# ── 页面路由 ───────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory(str(BASE_DIR), "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(str(BASE_DIR), filename)


# ── API 路由 ───────────────────────────────────────────

@app.route("/api/dates")
def api_dates():
    """列出所有有数据的日期（竞价快照 + 历史K线缓存）"""
    dates = set()
    # 竞价快照日期
    if DATA_DIR.exists():
        for f in DATA_DIR.glob("auction_*.json"):
            parts = f.stem.split("_")
            if len(parts) >= 2:
                dates.add(parts[1])
    # 历史K线缓存日期
    if HISTORY_DIR.exists():
        for f in HISTORY_DIR.glob("*.json"):
            parts = f.stem.split("_")
            if len(parts) >= 2:
                dates.add(parts[0])
    return jsonify({"success": True, "dates": sorted(dates, reverse=True)})


@app.route("/api/snapshot/latest")
def api_snapshot_latest():
    """获取指定日期最新的快照数据"""
    date_str = request.args.get("date", datetime.now().strftime("%Y%m%d"))
    pattern = f"auction_{date_str}_*.json"
    files = sorted(DATA_DIR.glob(pattern), reverse=True)
    if not files:
        return jsonify({"success": False, "message": f"未找到 {date_str} 的快照数据"})

    with open(files[0], "r", encoding="utf-8") as f:
        data = json.load(f)

    prev_date = _find_previous_date(date_str)
    prev_data = None
    prev_file = None
    if prev_date:
        prev_file = _find_latest_snapshot(prev_date)
        if prev_file:
            with open(prev_file, "r", encoding="utf-8") as f:
                prev_data = json.load(f)

    return jsonify({
        "success": True,
        "file": files[0].name,
        "prev_date": prev_date,
        "prev_file": prev_file.name if prev_file else None,
        **data,
        "_prev_data": prev_data,
    })


@app.route("/api/snapshot")
def api_snapshot():
    """获取指定日期的快照数据"""
    date_str = request.args.get("date")
    if not date_str:
        return jsonify({"success": False, "message": "缺少 date 参数"})

    pattern = f"auction_{date_str}_*.json"
    files = sorted(DATA_DIR.glob(pattern), reverse=True)
    if not files:
        return jsonify({"success": False, "message": f"未找到 {date_str} 的快照数据"})

    with open(files[0], "r", encoding="utf-8") as f:
        data = json.load(f)

    return jsonify({
        "success": True,
        "file": files[0].name,
        "all_files": [f.name for f in files],
        **data,
    })


@app.route("/api/fetch", methods=["POST"])
def api_fetch():
    """触发竞价数据采集"""
    payload = request.get_json(silent=True) or {}
    date = payload.get("date")
    capture_time = payload.get("time")

    task_id = str(int(time.time() * 1000))
    _fetch_results[task_id] = {"status": "running"}

    t = threading.Thread(
        target=run_fetch_in_background,
        args=(task_id, date, capture_time),
    )
    t.start()

    return jsonify({
        "success": True,
        "task_id": task_id,
        "message": "采集任务已启动",
    })


@app.route("/api/fetch/status/<task_id>")
def api_fetch_status(task_id):
    """查询采集任务状态"""
    result = _fetch_results.get(task_id)
    if not result:
        return jsonify({"success": False, "message": "任务不存在"})
    return jsonify({"success": True, **result})


@app.route("/api/constituents")
def api_constituents():
    """
    获取指定板块的成分股列表（竞价成交额 + 昨日收盘价）
    参数：
      code  - 板块代码，如 BK1305
      page  - 页码，从 1 开始（默认 1）
      size  - 每页条数（默认 20）
    """
    code = request.args.get("code", "").strip()
    if not code:
        return jsonify({"success": False, "message": "缺少 code 参数"})

    page = max(1, int(request.args.get("page", 1)))
    size = max(1, min(100, int(request.args.get("size", 20))))

    fields = "f2,f3,f4,f6,f12,f14,f18"
    params = _urlencode({
        "pn": page, "pz": size, "po": 1, "np": 1,
        "fltt": 2, "invt": 2, "fid": "f6",
        "fs": f"b:{code}",
        "fields": fields,
    })
    url = f"https://push2.eastmoney.com/api/qt/clist/get?{params}"

    try:
        raw = _em_get(url, timeout=10)
    except Exception as e:
        return jsonify({"success": False, "message": f"请求东方财富 API 失败: {e}"})

    if not raw or not raw.get("data"):
        return jsonify({"success": False, "message": "未获取到成分股数据"})

    em_data = raw["data"]
    total = em_data.get("total", 0)
    diff = em_data.get("diff") or []

    stocks = []
    for item in diff:
        stocks.append({
            "code":       item.get("f12", "--"),
            "name":       item.get("f14", "--"),
            "price":      item.get("f2"),
            "change_pct": item.get("f3"),
            "change_amt": item.get("f4"),
            "amount":     item.get("f6"),
            "prev_close": item.get("f18"),
        })

    return jsonify({
        "success":     True,
        "code":        code,
        "total":       total,
        "page":        page,
        "size":        size,
        "total_pages": (total + size - 1) // size if total > 0 else 1,
        "stocks":      stocks,
    })


@app.route("/api/yesterday-compare")
def api_yesterday_compare():
    """
    获取昨日板块成交额数据，供前端做今日vs昨日对比
    参数：
      type - 板块类型：industry 或 concept
    逻辑：
      1. 优先从本地快照获取昨日数据
      2. 无快照则通过 K线 API 获取昨日板块数据
    返回：{ code: amount } 的映射
    """
    sector_type = request.args.get("type", "industry").strip()

    # 1. 尝试从本地竞价快照获取昨日数据
    today_str = datetime.now().strftime("%Y%m%d")
    prev_date = _find_previous_date(today_str)

    if prev_date:
        prev_file = _find_latest_snapshot(prev_date)
        if prev_file:
            try:
                with open(prev_file, "r", encoding="utf-8") as f:
                    prev_data = json.load(f)

                # 从快照中提取指定类型的板块成交额
                amount_map = {}
                type_data = prev_data.get("data", {}).get(sector_type, {})
                for sector in type_data.get("sectors", []):
                    code = sector.get("f12", "")
                    amount = sector.get("f6")
                    if code and amount is not None:
                        amount_map[code] = float(amount)

                return jsonify({
                    "success": True,
                    "source": "local_snapshot",
                    "date": prev_date,
                    "type": sector_type,
                    "count": len(amount_map),
                    "amounts": amount_map,
                })
            except Exception as e:
                print(f"[WARN] 读取昨日快照失败: {e}")

    # 2. 无本地快照，通过K线API获取昨日数据
    if not prev_date:
        # 没有快照文件，手动计算前一个工作日
        from datetime import timedelta
        dt = datetime.now()
        for i in range(1, 8):
            prev = dt - timedelta(days=i)
            prev_str = prev.strftime("%Y%m%d")
            # 简单跳过周末
            if prev.weekday() < 5:
                prev_date = prev_str
                break

    if not prev_date:
        return jsonify({"success": False, "message": "无法确定前一个交易日"})

    # 获取板块列表
    fs_map = {"industry": "m:90+t:2", "concept": "m:90+t:3"}
    fs = fs_map.get(sector_type, "m:90+t:2")

    # 检查K线缓存
    cache_file = HISTORY_DIR / f"{prev_date}_{sector_type}.json"
    if cache_file.exists():
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                cached = json.load(f)
            amount_map = {}
            for sector in cached.get("sectors", []):
                code = sector.get("f12", "")
                amount = sector.get("f6")
                if code and amount is not None:
                    amount_map[code] = float(amount)
            return jsonify({
                "success": True,
                "source": "kline_cache",
                "date": prev_date,
                "type": sector_type,
                "count": len(amount_map),
                "amounts": amount_map,
            })
        except Exception:
            pass

    # 无缓存，实时获取昨日K线
    sector_list = []
    page = 1
    while True:
        params = {
            "pn": page, "pz": 500, "po": 1, "np": 1,
            "fltt": 2, "invt": 2, "fid": "f3", "fs": fs,
            "fields": "f12,f14",
        }
        url = f"https://push2.eastmoney.com/api/qt/clist/get?{_urlencode(params)}"
        try:
            raw = _em_get(url, timeout=15)
        except Exception as e:
            return jsonify({"success": False, "message": f"获取板块列表失败: {e}"})
        if not raw or not raw.get("data"):
            break
        diff = raw["data"].get("diff") or []
        if not diff:
            break
        sector_list.extend(diff)
        total = raw["data"].get("total", 0)
        if len(sector_list) >= total:
            break
        page += 1

    if not sector_list:
        return jsonify({"success": False, "message": "未获取到板块列表"})

    # 并发获取K线
    amount_map = {}

    def _fetch_kline_amount(sector_item):
        code = sector_item.get("f12", "")
        secid = f"90.{code}"
        kline_url = (
            f"https://push2his.eastmoney.com/api/qt/stock/kline/get?"
            f"secid={secid}&fields1=f1,f2,f3,f4,f5,f6"
            f"&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"
            f"&klt=101&fqt=1&beg={prev_date}&end={prev_date}"
        )
        try:
            raw = _em_get(kline_url, timeout=20, retries=1)
            klines = raw.get("data", {}).get("klines", [])
            if klines:
                parts = klines[0].split(",")
                return code, _safe_float(parts[6])  # 成交额
        except Exception:
            pass
        return code, None

    try:
        with ThreadPoolExecutor(max_workers=10) as pool:
            futures = {pool.submit(_fetch_kline_amount, s): s for s in sector_list}
            for future in as_completed(futures, timeout=120):
                try:
                    code, amount = future.result(timeout=20)
                    if amount is not None:
                        amount_map[code] = amount
                except Exception:
                    pass
    except Exception as e:
        print(f"[WARN] yesterday-compare 部分请求超时: {e}")

    return jsonify({
        "success": True,
        "source": "eastmoney_kline",
        "date": prev_date,
        "type": sector_type,
        "count": len(amount_map),
        "amounts": amount_map,
    })


@app.route("/api/sectors")
def api_sectors():
    """
    获取所有板块列表（循环分页拉取完整数据）
    参数：
      type - 板块类型：industry（行业板块）或 concept（概念板块）
    返回数据中 f104=上涨家数, f105=下跌家数, f106=平盘家数
    成分股总数 = f104+f105+f106（东方财富板块列表API直接返回）
    """
    sector_type = request.args.get("type", "industry").strip()

    fs_map = {
        "industry": "m:90+t:2",
        "concept":  "m:90+t:3",
    }
    fs = fs_map.get(sector_type, "m:90+t:2")

    all_sectors = []
    page = 1
    page_size = 500

    while True:
        params = {
            "pn":   page,
            "pz":   page_size,
            "po":   1,
            "np":   1,
            "fltt": 2,
            "invt": 2,
            "fid":  "f3",
            "fs":   fs,
            "fields": "f2,f3,f4,f5,f6,f8,f12,f14,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,f104,f105,f106,f128,f136",
        }
        url = f"https://push2.eastmoney.com/api/qt/clist/get?{_urlencode(params)}"

        try:
            raw = _em_get(url, timeout=15)
        except Exception as e:
            return jsonify({"success": False, "message": f"请求东方财富 API 失败: {e}"})

        if not raw or not raw.get("data"):
            break

        data = raw["data"]
        diff = data.get("diff") or []
        if not diff:
            break

        all_sectors.extend(diff)

        total = data.get("total", 0)
        if len(all_sectors) >= total:
            break

        page += 1

    return jsonify({
        "success": True,
        "type":   sector_type,
        "total":   len(all_sectors),
        "sectors": all_sectors,
    })


@app.route("/api/stock-count")
def api_stock_count():
    """
    获取A股市场股票总数（通过东方财富股票列表API）
    沪深A股 + 创业板 + 科创板 + 北交所
    """
    # 东方财富沪深A股列表的 fs 参数
    # m:0+t:6  = 深圳A股
    # m:0+t:80 = 创业板
    # m:1+t:2  = 上海A股
    # m:1+t:23 = 科创板
    params = _urlencode({
        "pn": 1,
        "pz": 1,
        "po": 1,
        "np": 1,
        "fltt": 2,
        "invt": 2,
        "fid": "f3",
        "fs": "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23",
        "fields": "f12",
    })
    url = f"https://push2.eastmoney.com/api/qt/clist/get?{params}"

    try:
        raw = _em_get(url, timeout=10)
    except Exception as e:
        return jsonify({"success": False, "message": f"获取A股总数失败: {e}"})

    total = 0
    if raw and raw.get("data"):
        total = raw["data"].get("total", 0)

    return jsonify({
        "success": True,
        "total": total,
        "source": "东方财富",
        "scope": "沪深A股+创业板+科创板",
    })


@app.route("/api/sector-history")
def api_sector_history():
    """
    获取板块历史K线数据（按日期查询）
    通过东方财富 push2his API 获取板块日K数据
    参数：
      date - 日期，格式 YYYYMMDD
      type - 板块类型：industry 或 concept
    流程：
      1. 先查本地缓存 data/history/{date}_{type}.json
      2. 无缓存则并发获取全量板块K线数据（20并发，约3秒完成）
      3. 缓存到本地供后续快速查询
    """
    date_str = request.args.get("date", "").strip()
    sector_type = request.args.get("type", "industry").strip()

    if not date_str:
        return jsonify({"success": False, "message": "缺少 date 参数"})

    # 验证日期格式
    try:
        query_date = datetime.strptime(date_str, "%Y%m%d")
    except ValueError:
        return jsonify({"success": False, "message": f"日期格式错误: {date_str}，应为 YYYYMMDD"})

    # 1. 检查本地缓存
    cache_file = HISTORY_DIR / f"{date_str}_{sector_type}.json"
    if cache_file.exists():
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                cached = json.load(f)
            cached["source"] = "local_cache"
            return jsonify(cached)
        except Exception:
            pass  # 缓存损坏，重新获取

    # 2. 先获取板块列表（获取板块代码和名称）
    fs_map = {
        "industry": "m:90+t:2",
        "concept":  "m:90+t:3",
    }
    fs = fs_map.get(sector_type, "m:90+t:2")

    sector_list = []  # [{f12: code, f14: name, ...}]
    page = 1
    while True:
        params = {
            "pn": page, "pz": 500, "po": 1, "np": 1,
            "fltt": 2, "invt": 2, "fid": "f3", "fs": fs,
            "fields": "f2,f3,f4,f5,f6,f8,f12,f14,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,f104,f105,f106,f128,f136",
        }
        url = f"https://push2.eastmoney.com/api/qt/clist/get?{_urlencode(params)}"
        try:
            raw = _em_get(url, timeout=15)
        except Exception as e:
            return jsonify({"success": False, "message": f"获取板块列表失败: {e}"})

        if not raw or not raw.get("data"):
            break
        diff = raw["data"].get("diff") or []
        if not diff:
            break
        sector_list.extend(diff)
        total = raw["data"].get("total", 0)
        if len(sector_list) >= total:
            break
        page += 1

    if not sector_list:
        return jsonify({"success": False, "message": "未获取到板块列表"})

    # 3. 并发获取每个板块的K线数据
    # K线字段: 日期,开盘,收盘,最高,最低,成交量,成交额,振幅,涨跌幅,涨跌额,换手率
    beg_date = date_str
    end_date = date_str

    def _fetch_kline(sector_item):
        """获取单个板块的K线数据"""
        code = sector_item.get("f12", "")
        name = sector_item.get("f14", "")
        secid = f"90.{code}"

        kline_url = (
            f"https://push2his.eastmoney.com/api/qt/stock/kline/get?"
            f"secid={secid}&fields1=f1,f2,f3,f4,f5,f6"
            f"&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"
            f"&klt=101&fqt=1&beg={beg_date}&end={end_date}"
        )
        try:
            raw = _em_get(kline_url, timeout=20, retries=1)
            klines = raw.get("data", {}).get("klines", [])
            if klines:
                # 解析K线数据: "日期,开盘,收盘,最高,最低,成交量,成交额,振幅,涨跌幅,涨跌额,换手率"
                parts = klines[0].split(",")
                return {
                    "success": True,
                    "code": code,
                    "data": {
                        "f2":  _safe_float(parts[2]),   # 收盘价 → 最新价
                        "f3":  _safe_float(parts[8]),   # 涨跌幅
                        "f4":  _safe_float(parts[9]),   # 涨跌额
                        "f5":  _safe_int(parts[5]),     # 成交量(手)
                        "f6":  _safe_float(parts[6]),   # 成交额
                        "f8":  _safe_float(parts[10]),  # 换手率
                        "open": _safe_float(parts[1]),  # 开盘价
                        "high": _safe_float(parts[3]),  # 最高价
                        "low":  _safe_float(parts[4]),  # 最低价
                        "amplitude": _safe_float(parts[7]),  # 振幅
                    },
                }
            else:
                return {"success": False, "code": code, "data": None}
        except Exception as e:
            return {"success": False, "code": code, "error": str(e)}

    # 并发请求（10线程，避免请求太频繁被限制）
    sectors_result = []
    success_count = 0
    fail_count = 0

    try:
        with ThreadPoolExecutor(max_workers=10) as pool:
            futures = {pool.submit(_fetch_kline, s): s for s in sector_list}
            for future in as_completed(futures, timeout=120):
                sector_item = futures[future]
                try:
                    result = future.result(timeout=20)
                except Exception:
                    result = {"success": False, "code": sector_item.get("f12", ""), "data": None}

                # 合并板块列表数据 + K线历史数据
                merged = dict(sector_item)  # 保留原始字段（f12, f14 等）

                if result["success"] and result.get("data"):
                    kline_data = result["data"]
                    # 用K线数据覆盖实时字段
                    merged["f2"] = kline_data.get("f2", merged.get("f2"))    # 收盘价→最新价
                    merged["f3"] = kline_data.get("f3", merged.get("f3"))    # 涨跌幅
                    merged["f4"] = kline_data.get("f4", merged.get("f4"))    # 涨跌额
                    merged["f5"] = kline_data.get("f5", merged.get("f5"))    # 成交量
                    merged["f6"] = kline_data.get("f6", merged.get("f6"))    # 成交额
                    merged["f8"] = kline_data.get("f8", merged.get("f8"))    # 换手率
                    # 额外K线字段
                    merged["_open"] = kline_data.get("open")
                    merged["_high"] = kline_data.get("high")
                    merged["_low"] = kline_data.get("low")
                    merged["_amplitude"] = kline_data.get("amplitude")
                    # 清除实时专有字段（K线数据无这些值，避免混淆）
                    for key in ["f62", "f184", "f66", "f69", "f72", "f75", "f78", "f81", "f84", "f87", "f128", "f136"]:
                        merged.pop(key, None)
                    # 标记为历史模式
                    merged["_history_mode"] = True
                    success_count += 1
                else:
                    merged["_history_mode"] = True
                    merged["_fetch_failed"] = True
                    fail_count += 1

                sectors_result.append(merged)
    except Exception as e:
        # 整体超时或异常，返回已获取的部分数据
        print(f"[WARN] sector-history 部分请求超时: {e}")

    # 按涨跌幅排序（降序）
    sectors_result.sort(key=lambda x: x.get("f3", 0) or 0, reverse=True)

    response = {
        "success": True,
        "source": "eastmoney_kline",
        "date": date_str,
        "type": sector_type,
        "total": len(sectors_result),
        "success_count": success_count,
        "fail_count": fail_count,
        "sectors": sectors_result,
        "is_auction_data": None,
        "capture_time": "",
    }

    # 4. 缓存到本地
    try:
        HISTORY_DIR.mkdir(parents=True, exist_ok=True)
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(response, f, ensure_ascii=False)
    except Exception as e:
        print(f"[WARN] 缓存历史数据失败: {e}")

    return jsonify(response)


def _safe_float(val):
    """安全转换为浮点数"""
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def _safe_int(val):
    """安全转换为整数"""
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return None


# ── 工具函数 ───────────────────────────────────────────

def _find_previous_date(date_str):
    """查找前一个有数据的交易日"""
    from datetime import timedelta
    dt = datetime.strptime(date_str, "%Y%m%d")
    for i in range(1, 8):
        prev = dt - timedelta(days=i)
        prev_str = prev.strftime("%Y%m%d")
        if list(DATA_DIR.glob(f"auction_{prev_str}_*.json")):
            return prev_str
    return None


def _find_latest_snapshot(date_str):
    """查找指定日期最新的快照文件"""
    pattern = f"auction_{date_str}_*.json"
    files = sorted(DATA_DIR.glob(pattern), reverse=True)
    return files[0] if files else None


# ── 启动 ───────────────────────────────────────────────
if __name__ == "__main__":
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)

    print(f"\n{'=' * 50}")
    print(f"  板块竞价监控系统 - 本地服务")
    print(f"  访问: http://localhost:{PORT}")
    print(f"  采集: POST /api/fetch")
    print(f"  数据: GET  /api/snapshot/latest")
    print(f"  日期: GET  /api/dates")
    print(f"  历史: GET  /api/sector-history?date=YYYYMMDD&type=industry")
    print(f"{'=' * 50}\n")

    # 使用 waitress 替代 Flask 开发服务器（解决 Windows 上 urllib 在 Flask 中超时的问题）
    from waitress import serve
    serve(app, host="0.0.0.0", port=PORT, threads=8)
