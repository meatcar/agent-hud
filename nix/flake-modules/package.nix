{
  perSystem =
    { pkgs, ... }:
    let
      agent-hud-src = pkgs.stdenv.mkDerivation {
        pname = "agent-hud-src";
        version = "0.1.0";
        src = ../..;
        dontBuild = true;
        installPhase = ''
          mkdir -p $out
          cp -r src $out/
        '';
      };
    in
    {
      packages.default = pkgs.writeShellApplication {
        name = "agent-hud";
        runtimeInputs = [ pkgs.bun ];
        text = ''
          exec bun "${agent-hud-src}/src/index.ts" "$@"
        '';
      };
    };
}
