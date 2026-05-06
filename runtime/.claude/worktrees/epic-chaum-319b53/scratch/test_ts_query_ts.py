import tree_sitter_typescript as ts_ts
from tree_sitter import Language, Parser

def test_query(lang, query_str):
    try:
        query = lang.query(query_str)
        print(f"Query SUCCESS: {query_str[:30]}...")
        return True
    except Exception as e:
        print(f"Query FAILED: {query_str[:30]}... Error: {e}")
        return False

ts_lang = Language(ts_ts.language_typescript())
tsx_lang = Language(ts_ts.language_tsx())

query_ts = """
    (class_declaration
      name: (type_identifier) @class_name
      (class_heritage (_) @parent_name)? @parents
    ) @class
"""

print("Testing TypeScript:")
test_query(ts_lang, query_ts)
print("\nTesting TSX:")
test_query(tsx_lang, query_ts)
