"""
板块竞价数据采集脚本 - 方案B：真正集合竞价数据
在9:25之后运行，抓取所有板块的竞价成交额快照，存到本地JSON文件
用法：
  python fetch_auction.py          # 采集当前时间点的数据
  python fetch_auction.py --date 20260504  # 指定日期（回溯用）
"""
import requests
import time
import json
from pathlib import Path
from datetime import datetime, timedelta

# ── 配置 ──────────────────────────────────────────────────
DATA_DIR = Path(__file__).parent / "data" / "auction"
API_BASE = "https://push2.eastmoney.com/api/qt/clist/get"

# 板块类型配置
SECTOR_TYPES = {
    "industry": {"name": "行业板块", "fs": "m:90+t:2"},
    "concept":  {"name": "概念板块", "fs": "m:90+t:3"},
}

# 板块列表字段（f6=成交额，竞价时段即为竞价成交额）
SECTOR_FIELDS = "f2,f3,f4,f5,f6,f8,f12,f14,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,f104,f105,f106,f128,f136"


def _to_float(val, default=0.0):
    """安全转换为浮点数（东方财富 API 可能返回 int/float/str/None）"""
    if val is None:
        return default
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


def fetch_sector_snapshot(sector_type):
    """抓取单个板块类型的所有数据（分页遍历，API每页最多100条）"""
    cfg = SECTOR_TYPES[sector_type]
    all_sectors = []
    page = 1

    while True:
        params = {
            "pn": str(page),
            "pz": "100",
            "po": "1",
            "np": "1",
            "fltt": "2",
            "invt": "2",
            "fid": "f3",
            "fs": cfg["fs"],
            "fields": SECTOR_FIELDS,
            "_": str(int(time.time() * 1000)),
        }
        resp = requests.get(API_BASE, params=params, timeout=15)
        resp.raise_for_status()
        raw = resp.json()

        diff = raw.get("data", {}).get("diff", [])
        total = raw.get("data", {}).get("total", 0)
        all_sectors.extend(diff)

        print(f"  第 {page} 页: 获取 {len(diff)} 条，累计 {len(all_sectors)}/{total}")

        if len(all_sectors) >= total or not diff:
            break
        page += 1
        time.sleep(0.1)  # 避免请求过快

    return {"data": {"total": total, "diff": all_sectors}}


def fetch_all_sectors():
    """抓取所有板块（行业+概念）的数据"""
    all_data = {}
    for sector_type, cfg in SECTOR_TYPES.items():
        print(f"[采集] 正在抓取 {cfg['name']} 数据...")
        try:
            raw = fetch_sector_snapshot(sector_type)
            diff = raw.get("data", {}).get("diff", [])
            print(f"[采集] {cfg['name']} 获取到 {len(diff)} 个板块")
            all_data[sector_type] = {
                "name": cfg["name"],
                "count": len(diff),
                "sectors": diff,
            }
        except Exception as e:
            print(f"[采集] {cfg['name']} 失败: {e}")
            all_data[sector_type] = {"name": cfg["name"], "count": 0, "sectors": []}
    return all_data


def save_snapshot(data, trade_date=None, capture_time=None):
    """保存快照到本地JSON文件"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if trade_date is None:
        now = datetime.now()
        trade_date = now.strftime("%Y%m%d")
    if capture_time is None:
        capture_time = datetime.now().strftime("%H:%M:%S")

    # 判断是否在竞价时段采集
    now = datetime.now()
    h, m = now.hour, now.minute
    is_auction_time = (h == 9 and 15 <= m <= 30)
    auction_flag = is_auction_time

    if not is_auction_time:
        print(f"[提示] 当前时间 {capture_time} 不在竞价时段（9:15~9:30），")
        print("        采集的 f6 字段为全天成交额（竞价时段则为竞价额）。")

    filename = f"auction_{trade_date}_{capture_time.replace(':', '')}.json"
    filepath = DATA_DIR / filename

    payload = {
        "date": trade_date,
        "capture_time": capture_time,
        "captured_at": datetime.now().isoformat(),
        "is_auction_data": auction_flag,   # 标记是否为竞价时段数据
        "data": data,
    }

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(f"[保存] 快照已保存: {filepath}")
    return filepath


def find_latest_snapshot(trade_date=None):
    """查找指定日期最新的快照文件"""
    if trade_date is None:
        trade_date = datetime.now().strftime("%Y%m%d")

    pattern = f"auction_{trade_date}_*.json"
    files = sorted(DATA_DIR.glob(pattern), reverse=True)
    if not files:
        return None
    return files[0]


def load_snapshot(filepath):
    """加载快照文件"""
    with open(filepath, "r", encoding="utf-8") as f:
        return json.load(f)


def get_previous_trade_date(date_str):
    """获取前一个交易日的日期字符串（查找已有快照文件）"""
    dt = datetime.strptime(date_str, "%Y%m%d")
    for i in range(1, 8):
        prev = dt - timedelta(days=i)
        prev_str = prev.strftime("%Y%m%d")
        pattern = f"auction_{prev_str}_*.json"
        files = list(DATA_DIR.glob(pattern))
        if files:
            return prev_str
    return None


def build_comparison(current_data, prev_data):
    """构建当前数据与前一天数据的对比"""
    # 构建前一天的板块成交额映射：key=(板块类型, 板块代码)
    prev_map = {}
    if prev_data:
        for sector_type, type_data in prev_data.get("data", {}).items():
            for sector in type_data.get("sectors", []):
                code = sector.get("f12", "")
                if code:
                    key = (sector_type, code)
                    prev_map[key] = {
                        "amount": _to_float(sector.get("f6")),
                        "name": sector.get("f14", ""),
                    }

    # 为当前数据添加对比字段
    result = {}
    for sector_type, type_data in current_data.get("data", {}).items():
        compared = []
        for sector in type_data.get("sectors", []):
            code = sector.get("f12", "")
            name = sector.get("f14", "")
            cur_amount = _to_float(sector.get("f6"))

            key = (sector_type, code)
            prev_info = prev_map.get(key)

            if prev_info:
                prev_amount = prev_info["amount"]
                change = cur_amount - prev_amount
                if prev_amount != 0:
                    change_rate = (change / prev_amount) * 100
                else:
                    change_rate = 0.0 if change == 0 else (100.0 if change > 0 else -100.0)
                compared.append({
                    **sector,
                    "_prev_amount": prev_amount,
                    "_change": change,
                    "_change_rate": change_rate,
                })
            else:
                compared.append({
                    **sector,
                    "_prev_amount": None,
                    "_change": None,
                    "_change_rate": None,
                })
        result[sector_type] = {
            **type_data,
            "sectors": compared,
        }
    return result


# ── 命令行入口 ─────────────────────────────────────────────
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="板块竞价数据采集")
    parser.add_argument("--date", default=None, help="交易日期 YYYYMMDD（默认今天）")
    parser.add_argument("--time", default=None, help="采集时间 HH:MM:SS（默认现在）")
    parser.add_argument("--compare", action="store_true", help="显示与前一天的对比")
    args = parser.parse_args()

    print("=" * 50)
    print("板块竞价数据采集脚本（方案B）")
    print("=" * 50)

    # 确定交易日期
    if args.date:
        trade_date = args.date
    else:
        trade_date = datetime.now().strftime("%Y%m%d")

    capture_time = args.time or datetime.now().strftime("%H:%M:%S")

    # 检查时间提示
    now = datetime.now()
    if now.hour < 9 or (now.hour == 9 and now.minute < 15):
        print(f"[提示] 当前时间 {now.strftime('%H:%M:%S')} 早于9:15，竞价尚未开始")
        print("         将继续采集，但数据可能不完整")

    # 采集数据
    all_data = fetch_all_sectors()

    # 保存快照
    saved_path = save_snapshot(all_data, trade_date, capture_time)

    # 加载刚保存的数据（验证）
    saved = load_snapshot(saved_path)
    total_sectors = sum(
        d.get("count", 0)
        for d in saved["data"].values()
    )
    print(f"[完成] 共采集 {total_sectors} 个板块")

    # 对比前一天
    if args.compare or True:  # 默认总是尝试对比
        prev_date = get_previous_trade_date(trade_date)
        if prev_date:
            prev_file = find_latest_snapshot(prev_date)
            if prev_file:
                prev_data = load_snapshot(prev_file)
                print(f"[对比] 与 {prev_date} 数据对比（文件: {prev_file.name}）")

                # 统计变化
                cur_amounts = {}
                for type_data in saved["data"].values():
                    for s in type_data.get("sectors", []):
                        cur_amounts[s.get("f12", "")] = _to_float(s.get("f6"))

                prev_amounts = {}
                for type_data in prev_data["data"].values():
                    for s in type_data.get("sectors", []):
                        prev_amounts[s.get("f12", "")] = _to_float(s.get("f6"))

                # 计算总计变化
                cur_total = sum(cur_amounts.values())
                prev_total = sum(prev_amounts.values())
                if prev_total > 0:
                    total_rate = (cur_total - prev_total) / prev_total * 100
                else:
                    total_rate = 0

                print(f"  今日总计成交额: {cur_total:,.0f} 元 ({cur_total/1e8:.2f} 亿)")
                print(f"  昨日总计成交额: {prev_total:,.0f} 元 ({prev_total/1e8:.2f} 亿)")
                print(f"  变化: {cur_total - prev_total:+,.0f} 元 ({total_rate:+.2f}%)")
            else:
                print(f"[对比] 未找到 {prev_date} 的快照数据")
        else:
            print("[对比] 未找到前一个交易日的快照数据")

    print(f"\n快照文件: {saved_path}")
    print("=" * 50)
