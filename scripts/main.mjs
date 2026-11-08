const MODULE_ID = "simple-token-flip";
const FLAG_FACES = "faces";
const FLAG_CURRENT = "currentFace";

/* -------------------------------------------- */
/*  Initialisation & Paramètres                 */
/* -------------------------------------------- */

Hooks.once("init", () => {
  // Enregistrement de la durée d'animation
  game.settings.register(MODULE_ID, "animationDuration", {
    name: "TOKENFLIP.Settings.DurationName",
    hint: "TOKENFLIP.Settings.DurationHint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.NumberField({ nullable: false, min: 100, max: 2000, step: 50 }),
    default: 400
  });

  // Autorisation des joueurs
  game.settings.register(MODULE_ID, "allowPlayers", {
    name: "TOKENFLIP.Settings.AllowPlayersName",
    hint: "TOKENFLIP.Settings.AllowPlayersHint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.BooleanField(),
    default: true
  });

  // Exposition d'une API pour les Macros
  game.modules.get(MODULE_ID).api = {
    flip: flipToken,
    flipSelected: () => {
      for (const token of canvas.tokens.controlled) {
        flipToken(token.document);
      }
    }
  };
});

/* -------------------------------------------- */
/*  Logique de Flip et d'Animation (v13)        */
/* -------------------------------------------- */

/**
 * Retourne un TokenDocument vers une face cible ou la face suivante dans la liste.
 * @param {TokenDocument} tokenDoc - Le document du token à retourner.
 * @param {number|null} targetIndex - L'index de la face cible (optionnel).
 */
export async function flipToken(tokenDoc, targetIndex = null) {
  if (!tokenDoc.isOwner) return;
  if (!game.user.isGM && !game.settings.get(MODULE_ID, "allowPlayers")) return;

  let faces = tokenDoc.getFlag(MODULE_ID, FLAG_FACES) ?? [];
  if (!faces.length) return;

  // Si une seule face alternative a été configurée, on inclut automatiquement l'image de base
  if (faces.length === 1 && faces[0].img !== tokenDoc.texture.src) {
    faces = [
      { id: "base", label: tokenDoc.name, img: tokenDoc.texture.src },
      faces[0]
    ];
    await tokenDoc.setFlag(MODULE_ID, FLAG_FACES, faces);
  }

  if (faces.length < 2) return;

  // Déterminer l'index actuel et le prochain index
  let currentIndex = faces.findIndex(f => f.img === tokenDoc.texture.src);
  if (currentIndex === -1) currentIndex = tokenDoc.getFlag(MODULE_ID, FLAG_CURRENT) ?? 0;

  const nextIndex = targetIndex !== null ? targetIndex : (currentIndex + 1) % faces.length;
  const nextFace = faces[nextIndex];
  if (!nextFace || !nextFace.img) return;

  // Pré-chargement de la texture avant la mise à jour pour éviter tout clignotement
  await foundry.canvas.loadTexture(nextFace.img);

  // Mise à jour du document avec désactivation de l'animation de fondu par défaut de Foundry
  // et passage d'une option personnalisée `tokenFlip` pour déclencher notre animation sur tous les clients.
  await tokenDoc.update(
    {
      "texture.src": nextFace.img,
      [`flags.${MODULE_ID}.${FLAG_CURRENT}`]: nextIndex
    },
    {
      animate: false,
      tokenFlip: {
        duration: game.settings.get(MODULE_ID, "animationDuration")
      }
    }
  );
}

/**
 * Écoute les mises à jour de Token pour jouer l'animation de retournement (Flip 3D)
 * sans déformer le ratio du token.
 */
Hooks.on("updateToken", (tokenDoc, changed, options, userId) => {
  if (!options.tokenFlip) return;

  const token = tokenDoc.object;
  if (!token || !token.mesh) return;

  const duration = options.tokenFlip.duration || 400;
  const halfDuration = duration / 2;
  const animName = `token.flip.${tokenDoc.id}`;

  const CanvasAnimation = foundry.canvas.animation.CanvasAnimation;

  // Interrompt toute animation en cours sur ce token pour éviter les désynchronisations
  CanvasAnimation.terminateAnimation(animName);

  // 1. On demande à Foundry de recalculer immédiatement les vraies proportions Pixi
  if (typeof token._refreshMeshSizeAndScale === "function") {
    token._refreshMeshSizeAndScale();
  }

  // 2. On récupère l'échelle Pixi réelle et calculée (ex: 0.28, et non le multiplicateur 1.0)
  const baseScaleX = token.mesh.scale.x;

  // 3. Animation : écrasement horizontal vers 0, puis réouverture vers l'échelle exacte
  CanvasAnimation.animate(
    [{ parent: token.mesh.scale, attribute: "x", from: baseScaleX, to: 0 }],
    {
      name: animName,
      duration: halfDuration,
      easing: CanvasAnimation.easeInCircle
    }
  ).then(() => {
    if (!token.mesh || token.mesh.destroyed) return;

    return CanvasAnimation.animate(
      [{ parent: token.mesh.scale, attribute: "x", from: 0, to: baseScaleX }],
      {
        name: animName,
        duration: halfDuration,
        easing: CanvasAnimation.easeOutCircle
      }
    );
  }).finally(() => {
    // 4. Sécurité absolue : on restaure l'échelle exacte et on demande à Foundry de rafraîchir le mesh
    if (token.mesh && !token.mesh.destroyed) {
      token.mesh.scale.x = baseScaleX;
      if (typeof token._refreshMeshSizeAndScale === "function") {
        token._refreshMeshSizeAndScale();
      }
    }
  });
});

/* -------------------------------------------- */
/*  Interface : TokenHUD (ApplicationV2)        */
/* -------------------------------------------- */

Hooks.on("renderTokenHUD", (app, element, context, options) => {
  const tokenDoc = app.document;
  if (!tokenDoc) return;
  if (!game.user.isGM && !game.settings.get(MODULE_ID, "allowPlayers")) return;

  const faces = tokenDoc.getFlag(MODULE_ID, FLAG_FACES) ?? [];
  if (faces.length === 0) return;

  // En v13, ApplicationV2 passe directement un HTMLElement (mais on sécurise au cas où)
  const html = element instanceof HTMLElement ? element : element[0];
  const colRight = html.querySelector(".col.right");
  if (!colRight) return;

  // Création du bouton HUD
  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("control-icon", "token-flip-btn");
  button.dataset.tooltip = game.i18n.localize("TOKENFLIP.FlipButton");
  button.innerHTML = `<i class="fa-solid fa-repeat"></i>`;

  // Clic gauche : Passe directement à la face suivante
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    await flipToken(tokenDoc);
    app.render();
  });

  // Clic droit : Ouvre une palette listant toutes les faces enregistrées
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const existingMenu = button.querySelector(".token-flip-hud-menu");
    if (existingMenu) {
      existingMenu.remove();
      return;
    }

    const menu = document.createElement("div");
    menu.classList.add("token-flip-hud-menu");

    faces.forEach((face, idx) => {
      const item = document.createElement("div");
      item.classList.add("token-flip-hud-item");
      if (face.img === tokenDoc.texture.src) item.classList.add("active");

      item.innerHTML = `
        <img src="${face.img}" alt="${face.label || ""}" />
        <span>${face.label || `Face ${idx + 1}`}</span>
      `;

      item.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await flipToken(tokenDoc, idx);
        app.render();
      });

      menu.appendChild(item);
    });

    button.appendChild(menu);
  });

  colRight.appendChild(button);
});

/* -------------------------------------------- */
/*  Configuration : TokenConfig & Prototype     */
/* -------------------------------------------- */

/**
 * Injecte la liste des faces dans l'onglet "Apparence" de la configuration du Token ou PrototypeToken.
 */
function injectTokenConfig(app, element) {
  const html = element instanceof HTMLElement ? element : element[0];
  
  // Évite la double injection lors des re-rendus partiels d'ApplicationV2
  if (html.querySelector(".token-flip-config")) return;

  const appearanceTab = html.querySelector('.tab[data-tab="appearance"]');
  if (!appearanceTab) return;

  // En v13 / TokenApplicationMixin, le document ou DataModel est accessible via app.token (ou app.document pour TokenConfig)
  const token = app.token ?? app.document;
  if (!token) return;

  // Récupération des faces (compatible Document avec getFlag ou DataModel direct)
  const existingFaces = (typeof token.getFlag === "function")
    ? token.getFlag(MODULE_ID, FLAG_FACES)
    : token.flags?.[MODULE_ID]?.[FLAG_FACES];

  const faces = foundry.utils.deepClone(existingFaces ?? []);

  const fieldset = document.createElement("fieldset");
  fieldset.classList.add("token-flip-config");
  fieldset.innerHTML = `
    <legend>${game.i18n.localize("TOKENFLIP.ConfigLegend")}</legend>
    <div class="faces-list"></div>
    <button type="button" class="add-face-btn">
      <i class="fa-solid fa-plus"></i> ${game.i18n.localize("TOKENFLIP.AddFace")}
    </button>
  `;

  const listContainer = fieldset.querySelector(".faces-list");

  // Fonction interne pour re-générer les lignes avec des index propres (0, 1, 2...)
  const renderRows = () => {
    listContainer.innerHTML = "";
    faces.forEach((face, index) => {
      const row = document.createElement("div");
      row.classList.add("face-entry");

      // Champ caché pour conserver l'ID
      const idInput = document.createElement("input");
      idInput.type = "hidden";
      idInput.name = `flags.${MODULE_ID}.${FLAG_FACES}.${index}.id`;
      idInput.value = face.id || foundry.utils.randomID();

      // Champ texte pour le nom de la face
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.classList.add("face-name");
      nameInput.name = `flags.${MODULE_ID}.${FLAG_FACES}.${index}.label`;
      nameInput.value = face.label || "";
      nameInput.placeholder = game.i18n.localize("TOKENFLIP.FaceLabel");
      nameInput.addEventListener("input", (e) => {
        faces[index].label = e.target.value;
      });

      // Composant FilePicker natif Foundry v13
      const fpPicker = foundry.applications.elements.HTMLFilePickerElement.create({
        name: `flags.${MODULE_ID}.${FLAG_FACES}.${index}.img`,
        type: "imagevideo",
        value: face.img || ""
      });
      fpPicker.addEventListener("change", (e) => {
        faces[index].img = e.target.value;
      });

      // Bouton de suppression
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.classList.add("icon", "delete-face-btn");
      delBtn.dataset.tooltip = game.i18n.localize("TOKENFLIP.DeleteFace");
      delBtn.innerHTML = `<i class="fa-solid fa-trash"></i>`;
      delBtn.addEventListener("click", () => {
        faces.splice(index, 1);
        renderRows();
        app.setPosition({ height: "auto" });
      });

      row.append(idInput, nameInput, fpPicker, delBtn);
      listContainer.appendChild(row);
    });
  };

  renderRows();

  // Bouton d'ajout d'une nouvelle face
  fieldset.querySelector(".add-face-btn").addEventListener("click", () => {
    const currentSrc = token.texture?.src || "";
    const tokenName = token.name || app.actor?.name || "Face 1";

    if (faces.length === 0) {
      faces.push({
        id: foundry.utils.randomID(),
        label: tokenName,
        img: currentSrc
      });
    }

    faces.push({
      id: foundry.utils.randomID(),
      label: `Face ${faces.length + 1}`,
      img: currentSrc
    });

    renderRows();
    app.setPosition({ height: "auto" });
  });

  appearanceTab.appendChild(fieldset);
}

Hooks.on("renderTokenConfig", (app, element) => injectTokenConfig(app, element));
Hooks.on("renderPrototypeTokenConfig", (app, element) => injectTokenConfig(app, element));

/**
 * Nettoyage des données avant sauvegarde :
 * Dans Foundry, les formulaires sérialisent les index (ex: flags.module.faces.0.img) sous forme d'Objet { "0": {...}, "1": {...} }.
 * Ce hook intercepte la sauvegarde pour reconvertir proprement cet objet en véritable Array JS, ou vider le flag si toutes les faces ont été supprimées.
 */
function sanitizeFacesFlag(doc, changed) {
  const facesData = changed.flags?.[MODULE_ID]?.[FLAG_FACES];
  if (facesData && !Array.isArray(facesData) && typeof facesData === "object") {
    changed.flags[MODULE_ID][FLAG_FACES] = Object.values(facesData).filter(f => f && f.img);
  }
}

Hooks.on("preUpdateToken", (doc, changed) => sanitizeFacesFlag(doc, changed));
Hooks.on("preUpdateActor", (actor, changed) => {
  const protoFaces = changed.prototypeToken?.flags?.[MODULE_ID]?.[FLAG_FACES];
  if (protoFaces && !Array.isArray(protoFaces) && typeof protoFaces === "object") {
    changed.prototypeToken.flags[MODULE_ID][FLAG_FACES] = Object.values(protoFaces).filter(f => f && f.img);
  }
});