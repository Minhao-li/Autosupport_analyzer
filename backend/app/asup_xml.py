"""Parse NetApp ASUP self-describing table XML files.

Every ASUP XML in an autosupport .files dir shares one schema:
  <T_TABLE ... smf_table_name smf_table_desc data_scope node_* >
    <asup:TABLE_INFO>
      <asup:field><asup:tag/><asup:smf_name/><asup:ui_name/>
                  <asup:type is_list=.../><asup:qualification/><asup:remap/></asup:field>...
    </asup:TABLE_INFO>
    <asup:ROW col_time_us=...> <tag>value</tag> ... </asup:ROW>...
    <asup:ABORT/>?
  </T_TABLE>

This module turns one file into {meta, columns, rows} ready for tabular display.
"""
import gzip
import xml.etree.ElementTree as ET

ASUP_NS = "http://asup_search.netapp.com/ns/ASUP/1.1"
_A = "{%s}" % ASUP_NS


def _localname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _list_values(el):
    """Return list of <asup:li> text values under an element (or None)."""
    lst = el.find(_A + "list")
    if lst is None:
        # also handle default-namespace 'list'
        for c in el:
            if _localname(c.tag) == "list":
                lst = c
                break
    if lst is None:
        return None
    out = []
    for li in lst:
        if _localname(li.tag) == "li":
            out.append((li.text or "").strip())
    return out


def _parse_generic_repeated(root, root_local, meta, max_rows):
    """Fallback for non-ASUP XML that is just a list of repeated record elements,
    e.g. <boottimes><boottime><time/><event/>...</boottime>...</boottimes>."""
    children = list(root)
    if not children:
        return {"ok": False, "error": "Empty / unsupported XML", "meta": meta}

    # group by local tag; pick the dominant repeated record tag
    from collections import Counter
    counts = Counter(_localname(c.tag) for c in children)
    record_tag, n = counts.most_common(1)[0]
    if n < 2:
        return {"ok": False, "error": "Not a tabular XML (no repeated records)", "meta": meta}

    records = [c for c in children if _localname(c.tag) == record_tag]
    col_order = []
    rows = []
    truncated = False
    for i, rec_el in enumerate(records):
        if i >= max_rows:
            truncated = True
            break
        rec = {}
        leaves = list(rec_el)
        if leaves:
            for cell in leaves:
                tag = _localname(cell.tag)
                lst = _list_values(cell)
                rec[tag] = lst if lst is not None else (cell.text or "").strip()
                if tag not in col_order:
                    col_order.append(tag)
        else:
            # leaf record: use attributes, else text
            if rec_el.attrib:
                for k, v in rec_el.attrib.items():
                    lk = _localname(k)
                    rec[lk] = v
                    if lk not in col_order:
                        col_order.append(lk)
            else:
                rec["value"] = (rec_el.text or "").strip()
                if "value" not in col_order:
                    col_order.append("value")
        rows.append(rec)

    meta.setdefault("table_name", root_local)
    if not meta.get("table_name"):
        meta["table_name"] = root_local
    if not meta.get("table_desc"):
        meta["table_desc"] = root_local
    columns = [{"tag": t, "ui_name": t, "type": None, "is_list": False} for t in col_order]
    return {
        "ok": True,
        "generic": True,
        "meta": meta,
        "columns": columns,
        "column_tags": col_order,
        "rows": rows,
        "row_count": len(rows),
        "total_rows": len(records),
        "truncated": truncated,
        "aborted": None,
    }


def parse_asup_xml(path: str, max_rows: int = 5000) -> dict:
    """Parse an ASUP table XML file. Returns a dict; sets ok=False if not an ASUP table."""
    try:
        src = gzip.open(path, "rb") if path.lower().endswith(".gz") else path
        tree = ET.parse(src)
    except (ET.ParseError, OSError, EOFError, gzip.BadGzipFile) as e:
        return {"ok": False, "error": f"XML parse error: {e}"}

    root = tree.getroot()
    root_local = _localname(root.tag)

    meta = {
        "root": root_local,
        "table_name": root.get("smf_table_name"),
        "table_desc": root.get("smf_table_desc"),
        "data_scope": root.get("data_scope"),
        "node_sn": root.get("node_sn"),
        "node_system_id": root.get("node_system_id"),
        "cluster_uuid": root.get("cluster_uuid"),
        "node_uuid": root.get("node_uuid"),
        "col_time_us": root.get("col_time_us"),
    }

    table_info = None
    rows_el = []
    aborted = None
    for child in root:
        ln = _localname(child.tag)
        if ln == "TABLE_INFO":
            table_info = child
        elif ln == "ROW":
            rows_el.append(child)
        elif ln == "ABORT":
            aborted = (child.text or "").strip() or "aborted"

    if table_info is None and not rows_el:
        return _parse_generic_repeated(root, root_local, meta, max_rows)

    # ---- columns from TABLE_INFO ----
    columns = []
    if table_info is not None:
        for field in table_info:
            if _localname(field.tag) != "field":
                continue
            col = {"tag": None, "smf_name": None, "ui_name": None,
                   "type": None, "is_list": False, "qualification": None}
            for sub in field:
                name = _localname(sub.tag)
                if name == "type":
                    col["type"] = (sub.text or "").strip()
                    col["is_list"] = sub.get("is_list") == "true"
                elif name in col:
                    col[name] = (sub.text or "").strip()
            if col["tag"]:
                columns.append(col)

    col_tags = [c["tag"] for c in columns]

    # ---- rows ----
    rows = []
    truncated = False
    for i, row_el in enumerate(rows_el):
        if i >= max_rows:
            truncated = True
            break
        rec = {}
        for cell in row_el:
            tag = _localname(cell.tag)
            lst = _list_values(cell)
            if lst is not None:
                rec[tag] = lst
            else:
                rec[tag] = (cell.text or "").strip()
        # ensure all declared columns present (order preserved later by columns)
        rows.append(rec)

    # If no TABLE_INFO, infer columns from the first rows.
    if not columns and rows:
        seen = []
        for r in rows:
            for k in r:
                if k not in seen:
                    seen.append(k)
        columns = [{"tag": k, "ui_name": k, "type": None, "is_list": False} for k in seen]
        col_tags = seen

    return {
        "ok": True,
        "meta": meta,
        "columns": columns,
        "column_tags": col_tags,
        "rows": rows,
        "row_count": len(rows),
        "total_rows": len(rows_el),
        "truncated": truncated,
        "aborted": aborted,
    }
