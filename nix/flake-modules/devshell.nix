{
  imports = [
    ./treefmt.nix
  ];
  perSystem =
    {
      pkgs,
      config,
      ...
    }:
    {
      legacyPackages = pkgs;
      devShells.default = pkgs.mkShell {
        name = "agent-hud";
        inputsFrom = [
          config.flake-root.devShell
          config.treefmt.build.devShell
        ];
        buildInputs =
          with pkgs;
          (builtins.attrValues config.treefmt.build.programs)
          ++ [
            nil # nix lsp
          ]
          ++ [
            bun
            jujutsu # vcs drift tests spawn jj
            # TODO: use default nodejs once nixos-26.05 Node 24 links brotli 1.2.1 (CVE-2026-111497).
            # see https://nixpk.gs/pr-tracker.html?pr=577244
            nodejs_22
          ];
      };
    };
}
