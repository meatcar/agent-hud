{
  description = "Fast statusline HUD for Claude Code";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        agent-hud-src = pkgs.stdenv.mkDerivation {
          pname = "agent-hud-src";
          version = "0.1.0";
          src = ./.;
          dontBuild = true;
          installPhase = ''
            mkdir -p $out
            cp -r src $out/
          '';
        };
      in {
        packages.default = pkgs.writeShellApplication {
          name = "agent-hud";
          runtimeInputs = [ pkgs.bun ];
          text = ''
            exec bun "${agent-hud-src}/src/index.ts" "$@"
          '';
        };
      }
    );
}
