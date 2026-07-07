// hope-postgres — a first-party reference hope plugin: a PGAdmin-class panel for
// any Postgres database. Its own module so it can carry a database driver while
// the hope plugin SDK stays stdlib-only; the replace points at the in-repo SDK.
module github.com/toyz/hope/examples/plugins/hope-postgres

go 1.25.0

require (
	github.com/jackc/pgx/v5 v5.10.0
	github.com/toyz/hope/plugin v0.0.3
)

require (
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	golang.org/x/sync v0.17.0 // indirect
	golang.org/x/text v0.29.0 // indirect
)

replace github.com/toyz/hope/plugin => ../../../plugin
