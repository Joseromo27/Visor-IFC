// Quita elementos de un IFC conservando todo lo demas tal cual.
//
// Para que sirva de entregable, el archivo que sale tiene que ser "la misma
// exportacion menos esto": mismos GUID, mismo orden, misma cabecera, los
// mismos numeros con los mismos decimales. Por eso se edita el texto STEP del
// original en vez de cargar el modelo y volver a escribirlo con una libreria,
// que produciria su propia version del archivo.
//
// Lo que de verdad decide si esto funciona o genera basura son las
// referencias. Borrar un elemento no es borrar su linea: hay que sacarlo de
// los conjuntos que lo listan y borrar en cascada las relaciones que se
// quedan sin sentido. Y hay un limite deliberado: **no se recoge la geometria
// huerfana**. Un IFC con entidades no referenciadas es valido; el archivo
// queda algo mas gordo, pero no se corre el riesgo de borrar una
// representacion que comparta con un elemento que si se queda.

use std::collections::HashSet;

/// Una entidad del fichero: `#123=IFCMURO(...);`
struct Entidad {
    id: u32,
    /// Posicion del `#` que la abre.
    inicio: usize,
    /// Posicion justo despues del `;` que la cierra.
    fin: usize,
    /// Posicion de la `(` que abre los argumentos y de su `)`.
    args: (usize, usize),
    tipo_rel: bool,
}

/// Una referencia `#123` dentro de los argumentos de una entidad.
struct Referencia {
    id: u32,
    inicio: usize,
    /// 1 = argumento suelto; 2 o mas = dentro de una lista.
    profundidad: usize,
}

#[derive(Default)]
pub struct Informe {
    /// Elementos pedidos que se encontraron y se quitaron.
    pub eliminados: Vec<String>,
    /// GUID pedidos que no aparecen en el archivo.
    pub no_encontrados: Vec<String>,
    /// Relaciones que se quedaron sin objetos y se borraron enteras.
    pub relaciones_eliminadas: usize,
    /// Relaciones a las que solo se les quito algun miembro.
    pub relaciones_reparadas: usize,
    /// Entidades borradas en total, incluidas las de cascada.
    pub lineas_borradas: usize,
    pub bytes_entrada: usize,
    pub bytes_salida: usize,
    /// Casos que no se saben tratar. Si hay alguno, no se escribe nada.
    pub bloqueos: Vec<String>,
}

/// Recorre el texto marcando donde empieza y acaba cada entidad.
///
/// No vale partir por lineas: STEP permite que una entidad ocupe varias, y el
/// `;` que la cierra puede aparecer dentro de una cadena. Se avanza caracter
/// a caracter respetando cadenas (`'...'`, con `''` para una comilla) y
/// comentarios (`/* ... */`).
fn indexar(datos: &[u8]) -> Vec<Entidad> {
    let mut entidades = Vec::new();
    let mut i = 0usize;
    let n = datos.len();

    while i < n {
        // Saltar hasta el proximo `#` que abra una entidad, respetando
        // cadenas y comentarios.
        match datos[i] {
            b'\'' => {
                i += 1;
                while i < n {
                    if datos[i] == b'\'' {
                        if i + 1 < n && datos[i + 1] == b'\'' {
                            i += 2;
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    i += 1;
                }
                continue;
            }
            b'/' if i + 1 < n && datos[i + 1] == b'*' => {
                i += 2;
                while i + 1 < n && !(datos[i] == b'*' && datos[i + 1] == b'/') {
                    i += 1;
                }
                i = (i + 2).min(n);
                continue;
            }
            b'#' => {}
            _ => {
                i += 1;
                continue;
            }
        }

        let inicio = i;
        let mut j = i + 1;
        let mut id: u64 = 0;
        let mut digitos = 0;
        while j < n && datos[j].is_ascii_digit() {
            id = id * 10 + (datos[j] - b'0') as u64;
            j += 1;
            digitos += 1;
        }

        // `#12` suelto dentro de argumentos no abre entidad: solo cuenta si
        // le sigue un `=`.
        let mut k = j;
        while k < n && (datos[k] as char).is_whitespace() {
            k += 1;
        }
        if digitos == 0 || k >= n || datos[k] != b'=' {
            i = j.max(i + 1);
            continue;
        }

        // Nombre del tipo, hasta el parentesis de los argumentos.
        let mut p = k + 1;
        while p < n && (datos[p] as char).is_whitespace() {
            p += 1;
        }
        let tipo_inicio = p;
        while p < n && datos[p] != b'(' {
            p += 1;
        }
        if p >= n {
            break;
        }
        let tipo = String::from_utf8_lossy(&datos[tipo_inicio..p])
            .trim()
            .to_ascii_uppercase();
        let abre = p;

        // Avanzar hasta el `)` que cierra los argumentos y luego hasta el `;`.
        let mut prof = 0usize;
        let mut cierra = abre;
        while p < n {
            match datos[p] {
                b'\'' => {
                    p += 1;
                    while p < n {
                        if datos[p] == b'\'' {
                            if p + 1 < n && datos[p + 1] == b'\'' {
                                p += 2;
                                continue;
                            }
                            break;
                        }
                        p += 1;
                    }
                }
                b'(' => prof += 1,
                b')' => {
                    prof -= 1;
                    if prof == 0 {
                        cierra = p;
                        break;
                    }
                }
                _ => {}
            }
            p += 1;
        }
        while p < n && datos[p] != b';' {
            p += 1;
        }
        let fin = (p + 1).min(n);

        entidades.push(Entidad {
            id: id as u32,
            inicio,
            fin,
            args: (abre, cierra),
            tipo_rel: tipo.starts_with("IFCREL"),
        });
        i = fin;
    }

    entidades
}

/// Referencias `#123` dentro de los argumentos, con su profundidad.
fn referencias(datos: &[u8], e: &Entidad) -> Vec<Referencia> {
    let mut refs = Vec::new();
    let (abre, cierra) = e.args;
    let mut prof = 0usize;
    let mut i = abre;

    while i <= cierra {
        match datos[i] {
            b'\'' => {
                i += 1;
                while i <= cierra {
                    if datos[i] == b'\'' {
                        if i + 1 <= cierra && datos[i + 1] == b'\'' {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
            }
            b'(' => prof += 1,
            b')' => prof = prof.saturating_sub(1),
            b'#' => {
                let inicio = i;
                let mut j = i + 1;
                let mut id: u64 = 0;
                while j <= cierra && datos[j].is_ascii_digit() {
                    id = id * 10 + (datos[j] - b'0') as u64;
                    j += 1;
                }
                if j > inicio + 1 {
                    refs.push(Referencia {
                        id: id as u32,
                        inicio,
                        profundidad: prof,
                    });
                    i = j;
                    continue;
                }
            }
            _ => {}
        }
        i += 1;
    }

    refs
}

/// Primer argumento si es una cadena: en IfcRoot, el GlobalId.
fn guid(datos: &[u8], e: &Entidad) -> Option<String> {
    let (abre, cierra) = e.args;
    let mut i = abre + 1;
    while i <= cierra && (datos[i] as char).is_whitespace() {
        i += 1;
    }
    if i > cierra || datos[i] != b'\'' {
        return None;
    }
    let inicio = i + 1;
    let mut j = inicio;
    while j <= cierra {
        if datos[j] == b'\'' {
            if j + 1 <= cierra && datos[j + 1] == b'\'' {
                j += 2;
                continue;
            }
            break;
        }
        j += 1;
    }
    Some(String::from_utf8_lossy(&datos[inicio..j]).to_string())
}

/// Limites de la lista (parentesis) que contiene una posicion dada.
fn lista_que_contiene(datos: &[u8], e: &Entidad, pos: usize) -> Option<(usize, usize)> {
    let (abre, cierra) = e.args;
    let mut pila: Vec<usize> = Vec::new();
    let mut i = abre;
    while i <= cierra {
        match datos[i] {
            b'\'' => {
                i += 1;
                while i <= cierra {
                    if datos[i] == b'\'' {
                        if i + 1 <= cierra && datos[i + 1] == b'\'' {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
            }
            b'(' => pila.push(i),
            b')' => {
                if let Some(ini) = pila.pop() {
                    if ini < pos && pos < i && ini != abre {
                        return Some((ini, i));
                    }
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Reescribe una lista quitando los elementos que son referencias a borrar.
/// Cada elemento que se conserva se copia tal cual, de modo que lo que haya
/// anidado dentro no se toca.
fn lista_sin(datos: &[u8], ini: usize, fin: usize, borrar: &HashSet<u32>) -> (String, usize) {
    let mut elementos: Vec<&[u8]> = Vec::new();
    let mut prof = 0usize;
    let mut desde = ini + 1;
    let mut i = ini + 1;

    while i < fin {
        match datos[i] {
            b'\'' => {
                i += 1;
                while i < fin {
                    if datos[i] == b'\'' {
                        if i + 1 < fin && datos[i + 1] == b'\'' {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
            }
            b'(' => prof += 1,
            b')' => prof = prof.saturating_sub(1),
            b',' if prof == 0 => {
                elementos.push(&datos[desde..i]);
                desde = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    if desde < fin {
        elementos.push(&datos[desde..fin]);
    }

    let quedan: Vec<&[u8]> = elementos
        .into_iter()
        .filter(|el| {
            let t = String::from_utf8_lossy(el);
            let t = t.trim();
            match t.strip_prefix('#').and_then(|d| d.parse::<u32>().ok()) {
                Some(id) => !borrar.contains(&id),
                None => true,
            }
        })
        .collect();

    let cuerpo: Vec<String> = quedan
        .iter()
        .map(|e| String::from_utf8_lossy(e).trim().to_string())
        .collect();
    (format!("({})", cuerpo.join(",")), cuerpo.len())
}

/// Quita del IFC los elementos con esos GlobalId y devuelve el texto nuevo.
///
/// Se trabaja con el archivo en memoria. Para un IFC de 700 MB eso son unos
/// 1,5 GB contando la salida, bastante menos que los picos de la conversion,
/// y a cambio el algoritmo de referencias queda simple y revisable.
pub fn depurar(datos: &[u8], guids: &[String], nota: Option<&str>) -> (Informe, Option<Vec<u8>>) {
    let mut informe = Informe {
        bytes_entrada: datos.len(),
        ..Default::default()
    };

    let entidades = indexar(datos);
    let pedidos: HashSet<&str> = guids.iter().map(|g| g.as_str()).collect();

    // 1. De GUID a numero de entidad.
    let mut borrar: HashSet<u32> = HashSet::new();
    let mut encontrados: HashSet<String> = HashSet::new();
    for e in &entidades {
        if let Some(g) = guid(datos, e) {
            if pedidos.contains(g.as_str()) {
                borrar.insert(e.id);
                encontrados.insert(g.clone());
                informe.eliminados.push(g);
            }
        }
    }
    for g in guids {
        if !encontrados.contains(g) {
            informe.no_encontrados.push(g.clone());
        }
    }
    if borrar.is_empty() {
        return (informe, None);
    }

    // 2. Cascada. Una relacion que apunta a algo borrado en un argumento
    //    suelto (el vano de un hueco, por ejemplo) no puede quedarse, y una
    //    que se queda sin miembros tampoco: el esquema no admite conjuntos
    //    vacios. Se repite hasta que el conjunto deja de crecer; en la
    //    practica son dos o tres vueltas.
    for _ in 0..8 {
        let antes = borrar.len();
        for e in &entidades {
            if borrar.contains(&e.id) {
                continue;
            }
            let refs = referencias(datos, e);
            let tocadas: Vec<&Referencia> =
                refs.iter().filter(|r| borrar.contains(&r.id)).collect();
            if tocadas.is_empty() {
                continue;
            }

            for r in &tocadas {
                if r.profundidad <= 1 {
                    // Referencia suelta a algo que desaparece.
                    if e.tipo_rel {
                        borrar.insert(e.id);
                    } else {
                        informe.bloqueos.push(format!(
                            "#{} apunta a #{} en un argumento suelto y no es una relacion",
                            e.id, r.id
                        ));
                    }
                } else if r.profundidad > 2 {
                    informe.bloqueos.push(format!(
                        "#{} referencia a #{} dentro de una lista anidada",
                        e.id, r.id
                    ));
                } else if let Some((ini, fin)) = lista_que_contiene(datos, e, r.inicio) {
                    let (_, quedan) = lista_sin(datos, ini, fin, &borrar);
                    if quedan == 0 && e.tipo_rel {
                        borrar.insert(e.id);
                    }
                }
            }
        }
        if borrar.len() == antes {
            break;
        }
    }

    if !informe.bloqueos.is_empty() {
        informe.bloqueos.sort();
        informe.bloqueos.dedup();
        return (informe, None);
    }

    // 3. Escritura. Todo lo que no cambia se copia byte a byte.
    let mut salida: Vec<u8> = Vec::with_capacity(datos.len());
    let mut cursor = 0usize;

    // La nota va despues de HEADER;, como comentario STEP: es trazabilidad y
    // ningun lector la interpreta como dato.
    if let Some(texto) = nota {
        if let Some(pos) = buscar(datos, b"HEADER;") {
            let corte = pos + "HEADER;".len();
            salida.extend_from_slice(&datos[..corte]);
            salida.extend_from_slice(b"\n/* ");
            salida.extend_from_slice(texto.as_bytes());
            salida.extend_from_slice(b" */");
            cursor = corte;
        }
    }

    for e in &entidades {
        if e.fin <= cursor {
            continue;
        }
        if borrar.contains(&e.id) {
            salida.extend_from_slice(&datos[cursor..e.inicio]);
            informe.lineas_borradas += 1;
            if e.tipo_rel {
                informe.relaciones_eliminadas += 1;
            }
            cursor = e.fin;
            // Dejar limpio el salto de linea que quedaba tras la entidad.
            while cursor < datos.len() && (datos[cursor] == b'\r' || datos[cursor] == b'\n') {
                cursor += 1;
            }
            continue;
        }

        let refs = referencias(datos, e);
        if !refs.iter().any(|r| borrar.contains(&r.id)) {
            continue;
        }

        // Entidad que sobrevive pero menciona algo borrado: se rehacen solo
        // las listas afectadas y el resto del texto se respeta.
        let mut listas: Vec<(usize, usize)> = Vec::new();
        for r in refs.iter().filter(|r| borrar.contains(&r.id)) {
            if let Some(l) = lista_que_contiene(datos, e, r.inicio) {
                if !listas.contains(&l) {
                    listas.push(l);
                }
            }
        }
        listas.sort();

        salida.extend_from_slice(&datos[cursor..e.inicio]);
        let mut local = e.inicio;
        for (ini, fin) in listas {
            let (nueva, _) = lista_sin(datos, ini, fin, &borrar);
            salida.extend_from_slice(&datos[local..ini]);
            salida.extend_from_slice(nueva.as_bytes());
            local = fin + 1;
        }
        salida.extend_from_slice(&datos[local..e.fin]);
        informe.relaciones_reparadas += 1;
        cursor = e.fin;
    }

    salida.extend_from_slice(&datos[cursor..]);
    informe.bytes_salida = salida.len();
    (informe, Some(salida))
}

fn buscar(heno: &[u8], aguja: &[u8]) -> Option<usize> {
    heno.windows(aguja.len()).position(|v| v == aguja)
}

#[cfg(test)]
mod pruebas {
    use super::depurar;

    /// Un IFC minimo con los casos que importan: dos muros en el mismo piso,
    /// un conjunto de propiedades compartido, una relacion que solo apunta al
    /// muro que se va, y otra que se quedara vacia.
    const MUESTRA: &str = "ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
ENDSEC;
DATA;
#1=IFCPROJECT('0proyecto000000000000',$,'Proyecto',$,$,$,$,$,$);
#2=IFCBUILDINGSTOREY('0piso00000000000000000',$,'Piso 1',$,$,$,$,$,$,0.);
#10=IFCWALL('0muro1000000000000000',$,'Muro 1',$,$,#30,#40,$);
#11=IFCWALL('0muro2000000000000000',$,'Muro 2',$,$,#31,#41,$);
#20=IFCRELCONTAINEDINSPATIALSTRUCTURE('0rel10000000000000000',$,$,$,(#10,#11),#2);
#21=IFCRELDEFINESBYPROPERTIES('0rel20000000000000000',$,$,$,(#10,#11),#50);
#22=IFCRELDEFINESBYPROPERTIES('0rel30000000000000000',$,$,$,(#10),#51);
#23=IFCOPENINGELEMENT('0hueco000000000000000',$,'Hueco',$,$,#32,#42,$);
#24=IFCRELVOIDSELEMENT('0rel40000000000000000',$,$,$,#10,#23);
#50=IFCPROPERTYSET('0pset1000000000000000',$,'Comun',$,(#60));
#51=IFCPROPERTYSET('0pset2000000000000000',$,'Solo muro 1',$,(#60));
#60=IFCPROPERTYSINGLEVALUE('Marca',$,IFCLABEL('A'),$);
ENDSEC;
END-ISO-10303-21;
";

    fn texto(salida: &Option<Vec<u8>>) -> String {
        String::from_utf8(salida.clone().expect("deberia haber salida")).unwrap()
    }

    #[test]
    fn quita_el_elemento_y_lo_saca_de_los_conjuntos() {
        let (informe, salida) = depurar(
            MUESTRA.as_bytes(),
            &["0muro1000000000000000".to_string()],
            None,
        );
        let t = texto(&salida);

        assert!(informe.bloqueos.is_empty(), "{:?}", informe.bloqueos);
        assert_eq!(informe.eliminados.len(), 1);
        assert!(informe.no_encontrados.is_empty());

        // El muro se va y el otro se queda.
        assert!(!t.contains("0muro1000000000000000"));
        assert!(t.contains("0muro2000000000000000"));

        // Sale del conjunto del piso, que conserva al otro.
        assert!(t.contains("IFCRELCONTAINEDINSPATIALSTRUCTURE('0rel10000000000000000',$,$,$,(#11),#2)"));

        // De las propiedades compartidas solo se le quita a el.
        assert!(t.contains("IFCRELDEFINESBYPROPERTIES('0rel20000000000000000',$,$,$,(#11),#50)"));

        // La relacion que solo lo nombraba a el se queda sin objetos y se va
        // entera; el conjunto de propiedades en si se queda, huerfano, que es
        // valido y mas seguro que borrar algo compartido.
        assert!(!t.contains("0rel30000000000000000"));
        assert!(t.contains("0pset2000000000000000"));

        // La relacion de vano apunta al muro en un argumento suelto: cascada.
        assert!(!t.contains("0rel40000000000000000"));

        // Y lo que no se toca sale identico.
        assert!(t.contains("#60=IFCPROPERTYSINGLEVALUE('Marca',$,IFCLABEL('A'),$);"));
        assert!(t.starts_with("ISO-10303-21;"));
        assert!(t.trim_end().ends_with("END-ISO-10303-21;"));
    }

    #[test]
    fn quitar_los_dos_vacia_la_relacion_entera() {
        let (informe, salida) = depurar(
            MUESTRA.as_bytes(),
            &[
                "0muro1000000000000000".to_string(),
                "0muro2000000000000000".to_string(),
            ],
            None,
        );
        let t = texto(&salida);

        assert!(informe.bloqueos.is_empty(), "{:?}", informe.bloqueos);
        assert_eq!(informe.eliminados.len(), 2);
        // Sin miembros, las tres relaciones de pertenencia desaparecen.
        assert!(!t.contains("0rel10000000000000000"));
        assert!(!t.contains("0rel20000000000000000"));
        assert!(!t.contains("0rel30000000000000000"));
        // El piso y el proyecto siguen.
        assert!(t.contains("0piso00000000000000000"));
        assert!(t.contains("0proyecto000000000000"));
    }

    #[test]
    fn avisa_de_los_guid_que_no_estan() {
        let (informe, salida) = depurar(
            MUESTRA.as_bytes(),
            &["0noexiste000000000000".to_string()],
            None,
        );
        assert!(salida.is_none(), "sin nada que quitar no se escribe archivo");
        assert_eq!(informe.no_encontrados.len(), 1);
        assert!(informe.eliminados.is_empty());
    }

    #[test]
    fn la_nota_va_en_la_cabecera_como_comentario() {
        let (_, salida) = depurar(
            MUESTRA.as_bytes(),
            &["0muro1000000000000000".to_string()],
            Some("Depurado por Visor IFC"),
        );
        let t = texto(&salida);
        assert!(t.contains("HEADER;\n/* Depurado por Visor IFC */"));
        // Y no estorba a lo que venia detras.
        assert!(t.contains("FILE_DESCRIPTION"));
    }

    /// El archivo puede traer la entidad repartida en varias lineas y comillas
    /// escapadas dentro de un nombre. Ni una cosa ni la otra pueden despistar
    /// al indice.
    #[test]
    fn soporta_entidades_partidas_y_comillas_escapadas() {
        let fuente = "ISO-10303-21;
HEADER;
ENDSEC;
DATA;
#1=IFCBUILDINGSTOREY('0piso00000000000000000',$,'Piso',$,$,$,$,$,$,0.);
#10=IFCWALL('0muro1000000000000000',$,'Muro d''agua; raro',$,$,$,$,$);
#11=IFCWALL(
  '0muro2000000000000000',
  $,
  'Muro 2',
  $,$,$,$,$);
#20=IFCRELCONTAINEDINSPATIALSTRUCTURE('0rel10000000000000000',$,$,$,(#10,#11),#1);
ENDSEC;
END-ISO-10303-21;
";
        let (informe, salida) = depurar(
            fuente.as_bytes(),
            &["0muro2000000000000000".to_string()],
            None,
        );
        let t = texto(&salida);
        assert!(informe.bloqueos.is_empty(), "{:?}", informe.bloqueos);
        assert_eq!(informe.eliminados.len(), 1);
        // Se fue el partido en varias lineas, y el del nombre con comilla y
        // punto y coma sigue entero.
        assert!(!t.contains("0muro2000000000000000"));
        assert!(t.contains("'Muro d''agua; raro'"));
        assert!(t.contains("(#10),#1"));
    }
}
