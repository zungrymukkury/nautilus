test-local:
	@sed -i '' 's/cluster = "mainnet"/cluster = "localnet"/' Anchor.toml
	@anchor test --skip-local-validator 2>&1
	@sed -i '' 's/cluster = "localnet"/cluster = "mainnet"/' Anchor.toml

