// KG3D-001 — Create MLConcept label and unique constraints
// Required by KG3D-F3

CREATE CONSTRAINT ml_concept_unique IF NOT EXISTS
FOR (c:MLConcept) REQUIRE c.canonical_name IS UNIQUE;

CREATE INDEX ml_concept_category IF NOT EXISTS
FOR (c:MLConcept) ON (c.category);

CREATE INDEX ml_concept_aot_layer IF NOT EXISTS
FOR (c:MLConcept) ON (c.aot_layer);
