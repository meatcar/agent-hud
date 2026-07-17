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
          ];
      };
    };
}
