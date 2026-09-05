// Evita que se abra una consola adicional en Windows en release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    visor_ifc_lib::run();
}
