import polars as pl
from pypes.meta.models import MetaModel, ArchitectureMeta, ArchitectureNode, DataFlow, EntityMeta, FieldMeta, NodeType
from pypes.meta.generator import ContractGenerator
from pypes.core.pipeline import PipelineOrchestrator
from pypes.contracts.models import SourceModel

# 1. SETUP DUMMY DATA (Bronze Layer)
# Normally this would be in S3/Trino, here we use local CSVs
trades_data = pl.DataFrame({
    "trade_id": ["T1", "T2", "T3"],
    "account_no": ["ACC-001", "ACC-002", "ACC-123"],
    "notional": [1000000.0, 500000000.0, 2000000.0], # T2 exceeds 100M threshold
    "instrument": ["AAPL", "TSLA", "GOOGL"]
})
trades_data.write_csv("data_trades.csv")

# 2. DEFINE DESIGN-FIRST META-MODEL
meta = MetaModel(
    project="Investment Bank Market Risk",
    architecture=ArchitectureMeta(
        nodes=[
            ArchitectureNode(id="FRONT_OFFICE", type=NodeType.OLTP),
            ArchitectureNode(id="MARKET_RISK_GOL", type=NodeType.OLAP)
        ],
        flows=[
            DataFlow(**{"from": "FRONT_OFFICE", "to": "MARKET_RISK_GOLD", "contract": "TradeAggregation"})
        ]
    ),
    entities=[
        EntityMeta(
            name="Trade",
            fields=[
                FieldMeta(name="trade_id", type="string", required=True),
                FieldMeta(name="account_no", type="string", required=True),
                FieldMeta(name="notional", type="float", threshold={"field": "notional", "max": 100000000})
            ]
        )
    ]
)

# 3. DERIVE CONTRACTS
contracts = ContractGenerator.derive_contracts(meta)
contract = contracts[0]

# Adjust contract for demo (point to local file)
contract.source = SourceModel(uri="data_trades.csv", format="csv")
contract.destination = SourceModel(uri="transformed_trades.parquet", format="parquet")

print(f"--- Generated Contract: {contract.contract_name} ---")
print(contract.model_dump_json(indent=2))

# 4. EXECUTE PIPELINE
orchestrator = PipelineOrchestrator()
result = orchestrator.run(contract)

print("\n--- Execution Result ---")
import json
print(json.dumps(result, indent=2))

# 5. VERIFY OUTPUT
if result["status"] == "COMPLETED_WITH_ERRORS":
    print("\n[!] Validation Failed as expected: T2 notionals exceeded 100M threshold.")
else:
    print("\n[+] Pipeline Succeeded.")

# Check the transformed data
df_result = pl.read_parquet("transformed_trades.parquet")
print("\n--- Sample Transformed Data (Silver) ---")
print(df_result)
