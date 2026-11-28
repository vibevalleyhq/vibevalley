use super::types::{Kind, LEdge, LNode};

/// Reverses the edges that close a cycle, found by depth-first search in declaration order.
pub fn orient(nodes: &[LNode], edges: &mut [LEdge]) {
    let n = nodes.len();
    let mut start = vec![0usize; n + 1];
    for e in edges.iter_mut() {
        e.reversed = nodes[e.head].kind == Kind::StartPort || nodes[e.tail].kind == Kind::EndPort;
        if !e.reversed {
            start[e.tail + 1] += 1;
        }
    }
    for i in 0..n {
        start[i + 1] += start[i];
    }
    let mut out = vec![0usize; start[n]];
    {
        let mut fill = start[..n].to_vec();
        for (i, e) in edges.iter().enumerate() {
            if !e.reversed {
                out[fill[e.tail]] = i;
                fill[e.tail] += 1;
            }
        }
    }
    let mut state = vec![0u8; n];
    let mut cursor = start[..n].to_vec();
    let mut stack: Vec<usize> = Vec::new();
    for root in 0..n {
        if state[root] != 0 {
            continue;
        }
        stack.push(root);
        state[root] = 1;
        while let Some(&v) = stack.last() {
            if cursor[v] < start[v + 1] {
                let ei = out[cursor[v]];
                cursor[v] += 1;
                let w = edges[ei].head;
                if state[w] == 1 {
                    edges[ei].reversed = true;
                } else if state[w] == 0 {
                    state[w] = 1;
                    stack.push(w);
                }
            } else {
                state[v] = 2;
                stack.pop();
            }
        }
    }
}

pub fn rank(nodes: &mut [LNode], edges: &[LEdge], step: i32) {
    let n = nodes.len();
    let m = edges.len();
    let mut from = vec![0usize; m];
    let mut to = vec![0usize; m];
    let mut len = vec![0i32; m];
    let mut out_start = vec![0usize; n + 1];
    let mut in_start = vec![0usize; n + 1];
    for (i, e) in edges.iter().enumerate() {
        let (a, b) = if e.reversed { (e.head, e.tail) } else { (e.tail, e.head) };
        from[i] = a;
        to[i] = b;
        len[i] = e.minlen.max(1) * step;
        out_start[a + 1] += 1;
        in_start[b + 1] += 1;
    }
    for i in 0..n {
        out_start[i + 1] += out_start[i];
        in_start[i + 1] += in_start[i];
    }
    let mut out_e = vec![0usize; m];
    let mut in_e = vec![0usize; m];
    {
        let mut of = out_start[..n].to_vec();
        let mut inf = in_start[..n].to_vec();
        for i in 0..m {
            out_e[of[from[i]]] = i;
            of[from[i]] += 1;
            in_e[inf[to[i]]] = i;
            inf[to[i]] += 1;
        }
    }

    let mut r = vec![0i32; n];
    for (i, node) in nodes.iter().enumerate() {
        if node.kind == Kind::StartPort {
            r[i] = -step;
        }
    }
    let mut indeg = vec![0usize; n];
    for i in 0..n {
        indeg[i] = in_start[i + 1] - in_start[i];
    }
    let mut topo = vec![0usize; n];
    let mut count = 0usize;
    for (i, &deg) in indeg.iter().enumerate() {
        if deg == 0 {
            topo[count] = i;
            count += 1;
        }
    }
    let mut q = 0usize;
    while q < count {
        let v = topo[q];
        q += 1;
        for &ei in &out_e[out_start[v]..out_start[v + 1]] {
            let w = to[ei];
            if r[v] + len[ei] > r[w] {
                r[w] = r[v] + len[ei];
            }
            indeg[w] -= 1;
            if indeg[w] == 0 {
                topo[count] = w;
                count += 1;
            }
        }
    }

    // Tighten loosely attached nodes toward the side with more incident edges.
    for _pass in 0..8 {
        let mut changed = false;
        for q in (0..count).rev() {
            let v = topo[q];
            let ins = in_start[v + 1] - in_start[v];
            let outs = out_start[v + 1] - out_start[v];
            if ins == 0 && outs == 0 {
                continue;
            }
            let mut lo: Option<i32> = None;
            let mut hi: Option<i32> = None;
            for &ei in &in_e[in_start[v]..in_start[v + 1]] {
                let cand = r[from[ei]] + len[ei];
                lo = Some(lo.map_or(cand, |cur| cur.max(cand)));
            }
            for &ei in &out_e[out_start[v]..out_start[v + 1]] {
                let cand = r[to[ei]] - len[ei];
                hi = Some(hi.map_or(cand, |cur| cur.min(cand)));
            }
            let mut next = r[v];
            if outs > ins
                && let Some(h) = hi
            {
                next = h;
            } else if ins > outs
                && let Some(l) = lo
            {
                next = l;
            }
            if next != r[v] {
                r[v] = next;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    let mut min_r: Option<i32> = None;
    let mut max_r: Option<i32> = None;
    let mut start_ports = false;
    for (i, node) in nodes.iter().enumerate() {
        match node.kind {
            Kind::StartPort => {
                start_ports = true;
            }
            Kind::EndPort => {}
            Kind::Node | Kind::Dummy | Kind::Label => {
                min_r = Some(min_r.map_or(r[i], |cur| cur.min(r[i])));
                max_r = Some(max_r.map_or(r[i], |cur| cur.max(r[i])));
            }
        }
    }
    let mut min_val = min_r.unwrap_or(0);
    let max_val = max_r.unwrap_or(0);
    for (i, node) in nodes.iter().enumerate() {
        match node.kind {
            Kind::StartPort => r[i] = min_val - step,
            Kind::EndPort => r[i] = max_val + step,
            Kind::Node | Kind::Dummy | Kind::Label => {}
        }
    }
    if start_ports {
        min_val -= step;
    }
    for (i, node) in nodes.iter_mut().enumerate() {
        node.rank = (r[i] - min_val) as usize;
    }
}
