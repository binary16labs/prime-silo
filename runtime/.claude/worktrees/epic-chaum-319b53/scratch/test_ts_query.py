import tree_sitter_javascript as tsjavascript
from tree_sitter import Language, Parser

def test_query(query_str):
    js_lang = Language(tsjavascript.language())
    try:
        query = js_lang.query(query_str)
        print(f"Query SUCCESS: {query_str[:30]}...")
        return True
    except Exception as e:
        print(f"Query FAILED: {query_str[:30]}... Error: {e}")
        return False

queries = [
    """
        (class_declaration
          name: (identifier) @class_name
          (class_heritage (identifier) @parent_name)? @parents
        ) @class

        (function_declaration
          name: (identifier) @function_name
        ) @function

        (method_definition
          name: (property_identifier) @method_name
        ) @method

        (import_statement) @import
    """
]

for q in queries:
    test_query(q)
