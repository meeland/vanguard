// ИМПОРТЫ
// Подключаем модули: сетевой движок, логику гексагональной сетки и словари с характеристиками кораблей, оружием и улучшениями.
import { Network, NETWORK_EVENTS } from './network.js';
import { HexMap } from './hexgrid.js';
import { ABILITIES, WEAPONS, UNIT_STATS, UPGRADES, STATUS_EFFECTS_DICT } from './ships.js';

// КОНСТАНТЫ И ПРЕДЗАГРУЗКА
const MAX_ARMY_SIZE = 16; // Максимальный размер флота игрока
const MAP_ICONS = {}; // Объект для кэширования иконок кораблей для отрисовки на Canvas
// Проходимся по всем типам кораблей и заранее загружаем их иконки в память
Object.values(UNIT_STATS).forEach(s => { const img = new Image(); img.src = s.icon; MAP_ICONS[s.icon] = img; });

// ГЛОБАЛЬНОЕ СОСТОЯНИЕ ИГРЫ (State)
// Хранит все текущие данные: от активной фазы до положения камеры.
const gameState = {
    phase: 'LOBBY', // Текущая фаза: LOBBY (лобби), DRAFT (сбор флота), SETUP (расстановка), COMBAT (бой)
    activePlayer: 'host', // Кто сейчас ходит ('host' или 'guest')
    turnCount: 1, // Номер текущего хода
    ready: { me: false, enemy: false }, // Статусы готовности игроков к переходу на следующую фазу
    mySide: null, // Роль текущего клиента ('host' или 'guest')
    
    map: null, // Экземпляр HexMap (карта)
    units: [], // Все юниты на карте (и свои, и вражеские)
    unitsToPlace: [], // Флот, выбранный на этапе драфта, ожидающий расстановки
    
    selectedUpgrades: [], // Выбранные игроком глобальные улучшения
    currentUpgradeTab: 'technology', // Текущая открытая вкладка в меню улучшений

    activeUnitId: null, // ID юнита, совершающего действие
    selectedUnitOnMap: null, // Юнит, выбранный кликом на карте
    editingUnitId: null, // ID юнита, информация о котором сейчас открыта в модальном окне
    currentFactionTab: 'standard', // Текущая выбранная фракция в драфте
    
    // Режимы действий (флаги интерфейса)
    moveMode: false, // Включен ли режим передвижения
    weaponMode: null, // Индекс выбранного оружия (если режим стрельбы)
    abilityMode: null, // ID выбранной способности (если режим способности)
    
    // Данные для отрисовки и наведения
    hoveredHex: null, // Гекс, над которым находится курсор
    hoveredUnitId: null, // ID юнита под курсором
    attackHovered: false, // Наведен ли курсор на цель для атаки
    currentAttackableHexes: [], // Массив гексов, доступных для атаки/способности в данный момент
    blockedAttackableHexes: [], // Массив гексов в радиусе, но заблокированных препятствиями (астероидами)
    
    // Настройки камеры Canvas
    camera: { x: 100, y: 100, isDragging: false, startX: 0, startY: 0 }
};

// ИНИЦИАЛИЗАЦИЯ
const network = new Network(); // Создаем экземпляр сетевого менеджера (WebRTC)

// Кэшируем все необходимые DOM-элементы интерфейса, чтобы не искать их каждый раз через document.getElementById
const ui = {
    lobby: document.getElementById('lobby-screen'), game: document.getElementById('game-screen'),
    draftScreen: document.getElementById('draft-screen'), draftRoster: document.getElementById('draft-roster'),
    draftArmy: document.getElementById('draft-army'), draftCount: document.getElementById('draft-count'),
    btnDraftReady: document.getElementById('btn-draft-ready'), 
    upgradesList: document.getElementById('upgrades-list'),
    
    infoModal: document.getElementById('unit-info-modal'), infoTitle: document.getElementById('info-title'), 
    infoHp: document.getElementById('info-hp'), infoShield: document.getElementById('info-shield'), 
    infoSpd: document.getElementById('info-spd'), infoTonnage: document.getElementById('info-tonnage'),
    infoWeapons: document.getElementById('info-weapons'), infoAbilities: document.getElementById('info-abilities'),
    btnInfoClose: document.getElementById('btn-info-close'), btnInfoDelete: document.getElementById('btn-info-delete'), 

    canvas: document.getElementById('game-canvas'), canvasContainer: document.getElementById('canvas-container'), 
    unitsList: document.getElementById('units-list'), actionPanel: document.getElementById('action-panel'), 
    lblPhase: document.getElementById('hud-phase'), lblTurn: document.getElementById('hud-turn'), 
    lblTurnCount: document.getElementById('hud-turn-count'), btnEndTurn: document.getElementById('btn-end-turn'), 
    hostBtn: document.getElementById('btn-host-start'), hostOfferOut: document.getElementById('host-offer-output'), 
    hostStatus: document.getElementById('host-status'), clientJoinBtn: document.getElementById('btn-client-join'), 
    clientOfferIn: document.getElementById('client-offer-input'), clientAnswerOut: document.getElementById('client-answer-output'), 
    clientStatus: document.getElementById('client-status'), hostFinishBtn: document.getElementById('btn-host-finish'), 
    hostAnswerIn: document.getElementById('host-answer-input'), legendHeader: document.getElementById('legend-header'), 
    btnLegend: document.getElementById('btn-toggle-legend'), pnlLegend: document.getElementById('legend-panel'), 
    hostControls: document.getElementById('host-controls'), btnRestart: document.getElementById('btn-restart'), 
    restartModal: document.getElementById('restart-modal'), btnRestartConfirm: document.getElementById('btn-restart-confirm'), 
    btnRestartCancel: document.getElementById('btn-restart-cancel'), tooltip: document.getElementById('ability-tooltip'), 
    ttIcon: document.getElementById('tt-icon'), ttName: document.getElementById('tt-name'), 
    ttType: document.getElementById('tt-type'), ttDesc: document.getElementById('tt-desc'), 
    ttCdBox: document.getElementById('tt-cd-box'), ttCd: document.getElementById('tt-cd'), 
    ttDamageBox: document.getElementById('tt-damage-box'), ttDamage: document.getElementById('tt-damage'), 
    ttRangeBox: document.getElementById('tt-range-box'), ttRange: document.getElementById('tt-range'), 
    ttChargesBox: document.getElementById('tt-charges-box'), ttCharges: document.getElementById('tt-charges'), 
    statusTooltip: document.getElementById('status-tooltip'), stDesc: document.getElementById('st-desc'), 
    stDuration: document.getElementById('st-duration')
};
const ctx = ui.canvas.getContext('2d'); // Контекст для рисования 2D графики

// ==========================================
// СЕТЕВЫЕ СОБЫТИЯ (WebRTC Логика)
// ==========================================

// Логика создания комнаты хостом (Генерация Offer-кода)
ui.hostBtn.onclick = async () => { ui.hostStatus.innerHTML="Генерация<span class='loading-dots'></span>"; ui.hostStatus.className="status-text status-process"; try { const o=await network.createOffer(); ui.hostOfferOut.value=o; ui.hostAnswerIn.disabled=false; ui.hostFinishBtn.disabled=false; gameState.mySide='host'; ui.hostStatus.textContent="оффер готов"; ui.hostStatus.className="status-text status-done"; } catch(e){ ui.hostStatus.textContent="Ошибка."; } };

// Логика подключения клиента (Ввод Offer-кода и генерация Answer-кода)
ui.clientJoinBtn.onclick = async () => { const o=ui.clientOfferIn.value.trim(); if(!o)return; ui.clientStatus.innerHTML="Подключение<span class='loading-dots'></span>"; ui.clientStatus.className="status-text status-process"; try { const a=await network.joinGame(o); ui.clientAnswerOut.value=a; gameState.mySide='guest'; ui.clientStatus.textContent="ответ готов"; ui.clientStatus.className="status-text status-done"; } catch(e){ ui.clientStatus.textContent="Ошибка."; } };

// Завершение подключения хостом (Ввод Answer-кода от клиента)
ui.hostFinishBtn.onclick = () => { const v=ui.hostAnswerIn.value.trim(); if(v)network.finalizeHandshake(v); };

// Кнопки копирования кодов в буфер обмена
document.getElementById('btn-copy-offer').onclick = () => { document.getElementById('host-offer-output').select(); navigator.clipboard.writeText(document.getElementById('host-offer-output').value); };
document.getElementById('btn-copy-answer').onclick = () => { document.getElementById('client-answer-output').select(); navigator.clipboard.writeText(document.getElementById('client-answer-output').value); };

// Обработка успешного соединения — запускаем сцену драфта
network.on(NETWORK_EVENTS.CONNECTED, () => initDraftScene()); 

// Централизованный обработчик входящих сетевых сообщений от оппонента
network.on(NETWORK_EVENTS.DATA, (msg) => {
    if (msg.type === 'RESTART_GAME') { performGameRestart(); } // Запрос на рестарт
    else if (msg.type === 'SYNC_MAP') { msg.payload.forEach(d => { const h=gameState.map.getHex(d.q,d.r); if(h)h.terrain=d.t; }); } // Синхронизация ландшафта (астероидов)
    else if (msg.type === 'PLACE_UNIT') { 
        // Размещение вражеского корабля на этапе SETUP
        const u={...msg.payload, owner:(gameState.mySide==='host'?'guest':'host')}; 
        gameState.units.push(u); 
        const h=gameState.map.getHex(u.q,u.r); if(h)h.unitId=u.id; 
        updateUnitMaxAP(u); 
    }
    else if (msg.type === 'PLAYER_READY') { 
        // Оппонент нажал "Готов" (в драфте или при расстановке)
        gameState.ready.enemy = true; 
        if (gameState.phase === 'DRAFT') checkStartSetup();
        else if (gameState.phase === 'SETUP') checkStartCombat();
    }
    else if (msg.type === 'END_TURN') { 
        // Оппонент завершил ход — передаем ход себе и обновляем интерфейс
        gameState.activePlayer = (gameState.activePlayer==='host'?'guest':'host'); 
        updateHud(); 
    }
    else if (msg.type === 'SYNC_COMBAT_STATE') {
        // Жесткая синхронизация стейта боя (вызывается в конце хода) для предотвращения рассинхрона
        gameState.units = msg.payload.units;
        gameState.map.getAllHexes().forEach(h => h.unitId = null); // Очищаем гексы
        gameState.units.forEach(u => { if (!u.isDead) { const h = gameState.map.getHex(u.q, u.r); if (h) h.unitId = u.id; } }); // Расставляем заново
        gameState.activePlayer = msg.payload.activePlayer; gameState.turnCount = msg.payload.turnCount;
        
        // Сброс локальных интерфейсных флагов
        gameState.selectedUnitOnMap = null; gameState.activeUnitId = null;
        gameState.currentAttackableHexes = []; gameState.blockedAttackableHexes = [];
        gameState.moveMode = false; gameState.weaponMode = null; gameState.abilityMode = null;
        ui.actionPanel.classList.add('hidden'); updateHud(); renderUnitsPanel();
    }
	else if (msg.type === 'UNIT_UPDATE') {
        // Точечное обновление характеристик юнита (например, после передвижения или получения урона)
        const u = gameState.units.find(un => un.id === msg.payload.id);
        if (u) {
            const oldHp = u.currentHp; const oldShield = u.currentShield;
            const oh = gameState.map.getHex(u.q, u.r); if(oh && oh.unitId===u.id) oh.unitId=null;
            Object.assign(u, msg.payload); updateUnitMaxAP(u); 
            
            // Если юнит получил урон, добавляем эффект тряски
            if (u.currentHp < oldHp || u.currentShield < oldShield) u.shakeUntil = Date.now() + 300; 
            
            if (!u.isDead) { const nh = gameState.map.getHex(u.q, u.r); if(nh) nh.unitId=u.id; }
            renderUnitsPanel();
        }
    }
	else if (msg.type === 'BATTLE_LOG') { 
        // Запись в боевой журнал о действиях оппонента
        const a = gameState.units.find(u => u.id === msg.payload.attackerId);
        const d = gameState.units.find(u => u.id === msg.payload.defenderId);
        if (a && d) addBattleLog(msg.payload.turn, a, d, msg.payload.damage, msg.payload.weaponName, msg.payload.isDead, msg.payload.isAbility);
    }
});

// Функция полного сброса состояния игры при рестарте
function performGameRestart() {
    gameState.phase = 'DRAFT'; gameState.turnCount = 1; gameState.activePlayer = 'host';
    gameState.units = []; gameState.unitsToPlace = []; gameState.ready = { me: false, enemy: false };
    gameState.selectedUnitOnMap = null; gameState.activeUnitId = null; gameState.selectedUpgrades = [];
    gameState.currentAttackableHexes = []; gameState.blockedAttackableHexes = []; gameState.weaponMode = null; gameState.abilityMode = null;
    if (gameState.map) gameState.map.getAllHexes().forEach(h => h.unitId = null);
    if (document.getElementById('battle-log')) document.getElementById('battle-log').innerHTML = '';
    ui.actionPanel.classList.add('hidden'); ui.game.classList.add('hidden'); ui.draftScreen.classList.remove('hidden');
    ui.btnDraftReady.innerText = "ГОТОВ К БИТВЕ"; ui.btnDraftReady.disabled = false;
    renderDraft();
}

// ==========================================
// ДРАФТ И УЛУЧШЕНИЯ (Сбор флота)
// ==========================================

// Переход из лобби в экран сборки флота
function initDraftScene() {
    ui.lobby.classList.add('hidden'); ui.draftScreen.classList.remove('hidden'); gameState.phase = 'DRAFT';
    
    // Инициализация карты 13x13 гексов, размер гекса 35px
    gameState.map = new HexMap(13, 13, 35);
    // Хост генерирует ландшафт и отправляет его гостю
    if (gameState.mySide === 'host') network.send('SYNC_MAP', gameState.map.getAllHexes().map(h => ({q:h.q, r:h.r, t:h.terrain})));
    
    // Переключение фракций в интерфейсе
    document.querySelectorAll('.faction-tab').forEach(tab => { tab.onclick = () => { gameState.currentFactionTab = tab.dataset.faction; renderDraft(); }; });
    
    // Переключение вкладок улучшений (технологии, протоколы и т.д.)
    document.querySelectorAll('.upg-tab-btn').forEach(btn => {
        btn.onclick = (e) => {
            document.querySelectorAll('.upg-tab-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            gameState.currentUpgradeTab = e.target.dataset.type;
            renderUpgrades();
        };
    });

    renderDraft();

    // Кнопка готовности к бою в драфте
    ui.btnDraftReady.onclick = () => {
        if (gameState.unitsToPlace.length === 0) return alert("Выберите хотя бы один корабль!");
        ui.infoModal.classList.add('hidden'); ui.btnDraftReady.disabled = true; ui.btnDraftReady.innerText = "Ожидание";
        gameState.ready.me = true; network.send('PLAYER_READY', {}); checkStartSetup(); // Проверяем, готовы ли оба
    };
    
    // Управление модальным окном характеристик
    ui.btnInfoClose.onclick = () => ui.infoModal.classList.add('hidden');
    ui.btnInfoDelete.onclick = () => { 
        if (gameState.editingUnitId) { // Удаление корабля из выбранного флота
            gameState.unitsToPlace = gameState.unitsToPlace.filter(u => u.id !== gameState.editingUnitId); 
            ui.infoModal.classList.add('hidden'); renderDraft(); 
        }
    };
}

// Отрисовка списка доступных улучшений
function renderUpgrades() {
    ui.upgradesList.innerHTML = '';
    Object.values(UPGRADES).forEach(upg => {
        if (upg.type !== gameState.currentUpgradeTab) return; // Показываем только текущую вкладку

        const card = document.createElement('div');
        card.className = 'upgrade-card';
        if (gameState.selectedUpgrades.includes(upg.id)) card.classList.add('selected'); // Подсвечиваем выбранные
        
        card.innerHTML = `
            <img class="upgrade-icon" src="${upg.icon}">
            <div class="upgrade-info">
                <div class="upgrade-name">${upg.name}</div>
                <div class="upgrade-desc">${upg.desc}</div>
            </div>
        `;
        
        // Логика добавления/удаления улучшения по клику
        card.onclick = () => {
            const index = gameState.selectedUpgrades.indexOf(upg.id);
            if (index > -1) {
                gameState.selectedUpgrades.splice(index, 1);
            } else {
                gameState.selectedUpgrades.push(upg.id);
            }
            renderUpgrades(); 
        };
        ui.upgradesList.appendChild(card);
    });
}

// Открытие окна детальной информации о выбранном типе корабля
function openUnitInfo(typeKey, unitId = null) {
    gameState.editingUnitId = unitId; 
    const stats = UNIT_STATS[typeKey];
    ui.infoTitle.innerText = stats.name;
    ui.infoHp.innerText = stats.maxHp; 
    
    // Предрасчет характеристик с учетом взятых игроком улучшений
    let finalShield = stats.maxShield;
    let finalSpeed = stats.speed;

    if (gameState.selectedUpgrades.includes('defense_protocols')) { finalShield = Math.floor(finalShield * 1.15); } // Улучшение щитов
    if (gameState.selectedUpgrades.includes('force_engines') && stats.tonnage === 'S') { finalSpeed += 1; } // Улучшение скорости легких кораблей

    ui.infoShield.innerText = finalShield; 
    ui.infoSpd.innerText = finalSpeed;
    ui.infoTonnage.innerText = stats.tonnage;

    ui.infoWeapons.innerHTML = '';
    if (stats.weapons) {
        stats.weapons.forEach(wKey => {
            let wDef = { ...WEAPONS[wKey] };
            // Применяем улучшения к характеристикам оружия
            if (gameState.selectedUpgrades.includes('artillery_traditions')) wDef.damage = Math.floor(wDef.damage * 1.1);
            if (gameState.selectedUpgrades.includes('sniper_training')) wDef.range += 1;

            const img = document.createElement('img');
            img.src = wDef.icon; 
            bindTooltip(img, wDef, true); // Привязываем всплывающую подсказку (тултип)
            ui.infoWeapons.appendChild(img);
        });
    }

    ui.infoAbilities.innerHTML = '';
    if (stats.abilities) {
        stats.abilities.forEach(aKey => {
            const a = ABILITIES[aKey]; const img = document.createElement('img');
            img.src = a.icon; 
            bindTooltip(img, a, false); 
            ui.infoAbilities.appendChild(img);
        });
    }

    ui.btnInfoDelete.style.display = unitId ? 'block' : 'none'; // Показываем кнопку "Удалить" только если это уже нанятый корабль
    ui.infoModal.classList.remove('hidden');
}

// Отрисовка списка доступных кораблей и набранного флота
function renderDraft() {
    renderUpgrades();
    ui.draftRoster.innerHTML = ''; ui.draftArmy.innerHTML = '';
    ui.draftCount.innerText = `Выбранный флот: ${gameState.unitsToPlace.length} / ${MAX_ARMY_SIZE}`;

    // Подсветка активной фракции
    document.querySelectorAll('.faction-tab').forEach(btn => { btn.classList.toggle('active', btn.dataset.faction === gameState.currentFactionTab); });

    // Рендер каталога (откуда набираем)
    Object.keys(UNIT_STATS).filter(k => UNIT_STATS[k].faction === gameState.currentFactionTab).forEach(key => {
        const card = createDraftCardHTML(key, false);
        card.onclick = () => { // При клике левой кнопкой — нанимаем во флот
            if (gameState.unitsToPlace.length < MAX_ARMY_SIZE) {
                // Генерируем уникальный ID для каждого купленного корабля
                gameState.unitsToPlace.push({ id: `u_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`, type: key, hasPlaced: false });
                renderDraft(); setTimeout(() => ui.draftArmy.scrollLeft = ui.draftArmy.scrollWidth, 50); // Прокручиваем список вправо
            }
        };
        card.oncontextmenu = (e) => { e.preventDefault(); openUnitInfo(key, null); }; // При клике правой кнопкой — смотрим инфо
        ui.draftRoster.appendChild(card);
    });

    // Рендер выбранного флота (внизу экрана драфта)
    gameState.unitsToPlace.forEach((u) => {
        const card = createDraftCardHTML(u.type, true);
        if (gameState.editingUnitId === u.id) card.classList.add('selected'); 
        card.onclick = () => openUnitInfo(u.type, u.id);
        ui.draftArmy.appendChild(card);
    });
}

// Вспомогательная функция для генерации HTML-кода карточки корабля
function createDraftCardHTML(typeKey, isArmy) {
    const s = UNIT_STATS[typeKey];
    const card = document.createElement('div'); card.className = `unit-card`; 

    // Генерация кубиков очков действий (AP)
    let apBlocksHtml = '<div class="card-ap-container">';
    for (let b = 0; b < s.speed; b++) apBlocksHtml += `<div class="ap-block"></div>`;
    apBlocksHtml += '</div>';

    card.innerHTML = `
        <div class="card-bars-container">
            <div class="card-shield-bar"><div class="card-shield-fill" style="width:100%;"></div><div class="card-shield-text"><span>${s.maxShield}</span><span class="regen-text">+${s.shieldRegen}</span></div></div>
            <div class="card-hp-bar"><div class="card-hp-fill" style="width:100%;"></div><div class="card-hp-text">${s.maxHp}</div></div>
        </div>
        <div class="card-image-container" style="background-image: url('${s.img}');">
            ${!isArmy ? `<div class="card-name-block">${s.name}</div>` : ''}
            ${apBlocksHtml}
        </div>
    `;
    return card;
}

// ==========================================
// ИГРА И ЛОГИКА (Фазы расстановки и боя)
// ==========================================

// Проверка готовности к переходу к расстановке на карте
function checkStartSetup() { if (gameState.ready.me && gameState.ready.enemy && gameState.phase === 'DRAFT') { gameState.phase = 'SETUP'; gameState.ready.me = false; gameState.ready.enemy = false; initGameScene(); } }

// Инициализация основного игрового экрана (отрисовка Canvas)
function initGameScene() {
    ui.draftScreen.classList.add('hidden'); ui.game.classList.remove('hidden');
    // Автоподстройка размера холста при изменении размера окна
    window.addEventListener('resize', () => { ui.canvas.width = ui.canvasContainer.clientWidth; ui.canvas.height = ui.canvasContainer.clientHeight; }); 
    window.dispatchEvent(new Event('resize'));
    
    // Кнопка рестарта доступна только хосту
    if (gameState.mySide === 'host') ui.hostControls.classList.remove('hidden');
    
    if (ui.btnRestart) ui.btnRestart.onclick = () => ui.restartModal.classList.remove('hidden');
    if (ui.btnRestartCancel) ui.btnRestartCancel.onclick = () => ui.restartModal.classList.add('hidden');
    if (ui.btnRestartConfirm) { 
        ui.btnRestartConfirm.onclick = () => { ui.restartModal.classList.add('hidden'); network.send('RESTART_GAME', {}); performGameRestart(); }; 
    }

    // Логика сворачивания панели "Легенда"
    if (ui.legendHeader && ui.pnlLegend) {
        ui.legendHeader.onclick = () => { 
            ui.pnlLegend.classList.toggle('hidden-panel'); 
            const isHidden = ui.pnlLegend.classList.contains('hidden-panel');
            ui.btnLegend.innerText = isHidden ? '◀' : '▼'; 
            
            const legendBox = document.getElementById('legend-box');
            if (isHidden) legendBox.classList.add('legend-expanded-padding');
            else legendBox.classList.remove('legend-expanded-padding');
        };
    }

    renderUnitsPanel(); updateHud();
    
    // Логика кнопки завершения хода
    ui.btnEndTurn.onclick = () => { 
        if (gameState.phase === 'SETUP') { 
            if (gameState.unitsToPlace.some(u => !u.hasPlaced)) return alert("Вы должны разместить все корабли на карте!"); 
            ui.btnEndTurn.disabled = true; ui.btnEndTurn.innerText = "ОЖИДАНИЕ..."; 
            gameState.ready.me = true; network.send('PLAYER_READY', {}); checkStartCombat(); 
        } else if (gameState.phase === 'COMBAT') {
            // Защита от случайного пропуска хода: нужно совершить хоть одно действие
            if (gameState.activePlayer === gameState.mySide) {
                const playerMadeAction = gameState.units.some(u => 
                    u.owner === gameState.mySide && !u.isDead && !u.hasActedThisTurn && 
                    (u.currentAP < u.maxAP || u.weapons.some(w => w.used) || u.abilityUsed)
                );
                if (!playerMadeAction) return alert("Вы должны совершить хотя бы одно действие перед завершением хода!");
            }
            endTurn(); 
        } 
    };
    requestAnimationFrame(gameLoop); // Запуск цикла отрисовки
}

// Обработка клика по гексу в фазе расстановки (SETUP)
function handleSetupPlacement(hex) {
    // Проверка зон расстановки (левый край для хоста, правый для гостя)
    const isMyZone = (gameState.mySide==='host' && hex.col<4) || (gameState.mySide==='guest' && hex.col>=9);
    const targetHex = gameState.map.getHex(hex.q, hex.r);
    // Нельзя ставить на занятый гекс, вне зоны или на астероид
    if (!isMyZone || hex.unitId || !targetHex || targetHex.terrain.id === 'asteroid') return;
    
    const c = gameState.unitsToPlace.find(i=>i.id===gameState.selectedCardId); const s = UNIT_STATS[c.type];
    
    // Итоговое применение улучшений к характеристикам конкретного юнита перед размещением
    let finalMaxShield = s.maxShield;
    let finalSpeed = s.speed;

    if (gameState.selectedUpgrades.includes('defense_protocols')) { finalMaxShield = Math.floor(finalMaxShield * 1.15); }
    if (gameState.selectedUpgrades.includes('force_engines') && s.tonnage === 'S') { finalSpeed += 1; }

    const finalWeapons = s.weapons.map((wKey, index) => {
        let wDef = { ...WEAPONS[wKey] };
        if (gameState.selectedUpgrades.includes('artillery_traditions')) { wDef.damage = Math.floor(wDef.damage * 1.1); }
        if (gameState.selectedUpgrades.includes('sniper_training')) { wDef.range += 1; }
        return { id: index, ref: wKey, used: false, customStats: wDef };
    });

    // Формирование боевого объекта юнита (State-объект)
    const u = { 
        id:`${gameState.mySide}_${Date.now()}`, type:c.type, 
        maxHp: s.maxHp, currentHp: s.maxHp, 
        maxShield: finalMaxShield, currentShield: finalMaxShield, shieldRegen: s.shieldRegen,
        baseSpeed: finalSpeed, maxAP: finalSpeed, currentAP: finalSpeed, 
        weapons: finalWeapons, cooldowns: {}, statusEffects: [],
        q: hex.q, r: hex.r, owner: gameState.mySide,
        isDead: false, hasActedThisTurn: false, abilityUsed: false 
    };
    
    gameState.units.push(u); hex.unitId=u.id; updateUnitMaxAP(u); u.currentAP = u.maxAP; 
    c.hasPlaced=true; gameState.selectedCardId=null; // Снимаем выбор
    gameState.currentAttackableHexes = []; gameState.blockedAttackableHexes = [];
    renderUnitsPanel(); network.send('PLACE_UNIT', u); // Отправляем врагу инфу о расстановке
}

// Старт боевой фазы
function checkStartCombat() { if (gameState.ready.me && gameState.ready.enemy && gameState.phase === 'SETUP') { gameState.phase = 'COMBAT'; gameState.turnCount = 0; gameState.activePlayer = 'host'; startGlobalTurn(); updateHud(); renderUnitsPanel(); } }

// Логика начала нового раунда (Восстановление AP, щитов, кулдаунов)
function startGlobalTurn() {
    gameState.turnCount++;
    gameState.units.forEach(u => {
        if (!u.isDead) {
            u.hasActedThisTurn = false; u.abilityUsed = false;
            u.weapons.forEach(w => w.used = false);
            
            // Обработка таймеров статусных эффектов (дебаффов)
            if (u.statusEffects) {
                for (let i = u.statusEffects.length - 1; i >= 0; i--) {
                    u.statusEffects[i].duration--;
                    if (u.statusEffects[i].duration <= 0) u.statusEffects.splice(i, 1);
                }
            }

            updateUnitMaxAP(u); u.currentAP = u.maxAP;
            u.currentShield = Math.min(u.maxShield, u.currentShield + u.shieldRegen); // Регенерация щитов
            for (let ab in u.cooldowns) { if (u.cooldowns[ab] > 0) u.cooldowns[ab]--; } // Уменьшение перезарядки способностей
        }
    });
}

// Расчет максимальных AP (очков действий) с учетом эффектов (например, 'stasis' режет скорость)
function updateUnitMaxAP(u) { 
    let baseSpeed = u.baseSpeed || UNIT_STATS[u.type].speed; 
    if (u.statusEffects && u.statusEffects.some(s => s.type === 'stasis')) { baseSpeed = Math.max(0, baseSpeed - 2); }
    u.maxAP = baseSpeed; if (u.currentAP > u.maxAP) u.currentAP = u.maxAP; 
}

// Математика гексагональной сетки: расчет расстояния между двумя гексами по кубическим координатам (Cube coordinates)
function hexDistance(q1, r1, q2, r2) { return Math.max(Math.abs(q1-q2), Math.abs(q1+r1-q2-r2), Math.abs(r1-r2)); }

// Проверка линии видимости (Line of Sight) с помощью алгоритма Брезенхема для гексов
function checkLineOfSight(startHex, endHex) {
    const N = hexDistance(startHex.q, startHex.r, endHex.q, endHex.r); if (N <= 1) return true; 
    
    // Переход в кубические координаты (q, r, s), где q+r+s = 0
    const aq = startHex.q, ar = startHex.r, as = -aq - ar; const bq = endHex.q, br = endHex.r, bs = -bq - br;
    
    // Искусственное смещение (эпсилон) для разрешения краевых случаев, когда линия проходит ровно по грани гекса
    const eq = 1e-6, er = 2e-6, es = -3e-6; const a = { q: aq + eq, r: ar + er, s: as + es }; const b = { q: bq + eq, r: br + er, s: bs + es };
    
    // Интерполяция точек на линии и проверка препятствий
    for (let i = 1; i < N; i++) {
        const t = i / N; const lq = a.q + (b.q - a.q) * t; const lr = a.r + (b.r - a.r) * t; const ls = a.s + (b.s - a.s) * t;
        const rounded = gameState.map.cubeRound(lq, lr, ls); const h = gameState.map.getHex(rounded.q, rounded.r);
        if (h && h.terrain.id === 'asteroid') return false; // Линия перекрыта астероидом
    }
    return true;
}

// Расчет конуса (радиуса) стрельбы из выбранного оружия
function updateWeaponCone(u, weaponIndex) { 
    gameState.currentAttackableHexes = []; gameState.blockedAttackableHexes = [];
    if(u.owner !== gameState.mySide || u.isDead) return; 
    
    const w = u.weapons[weaponIndex]; if(w.used) return;
    const wDef = w.customStats;
    const aHex = gameState.map.getHex(u.q, u.r);

    let range = wDef.range;
    // Дебафф 'jammed' (помехи) режет дальность стрельбы
    if (u.statusEffects && u.statusEffects.some(s => s.type === 'jammed')) { range = Math.max(1, range - 2); }

    // Сканирование карты на предмет целей в радиусе и прямой видимости
    gameState.map.getAllHexes().forEach(hex => { 
        const d = hexDistance(u.q, u.r, hex.q, hex.r); 
        if (d > 0 && d <= range) { 
            if (checkLineOfSight(aHex, hex)) gameState.currentAttackableHexes.push(hex); 
            else gameState.blockedAttackableHexes.push(hex);
        } 
    }); 
}

// Аналогично для способностей
function updateAbilityCone(u, abId) {
    gameState.currentAttackableHexes = []; gameState.blockedAttackableHexes = [];
    if(u.owner !== gameState.mySide || u.isDead) return;
    const abDef = ABILITIES[abId]; const aHex = gameState.map.getHex(u.q, u.r);

    gameState.map.getAllHexes().forEach(hex => {
        const d = hexDistance(u.q, u.r, hex.q, hex.r);
        if (d > 0 && d <= abDef.range) {
            if (checkLineOfSight(aHex, hex)) gameState.currentAttackableHexes.push(hex);
            else gameState.blockedAttackableHexes.push(hex);
        }
    });
}

// Завершение хода: передача управления или старт нового раунда
function endTurn() { 
    if (gameState.phase === 'SETUP') {
        gameState.activePlayer = (gameState.activePlayer === 'host') ? 'guest' : 'host'; updateHud(); network.send('END_TURN', {});
    } else if (gameState.phase === 'COMBAT') {
        // Помечаем активного юнита как "походившего"
        const actedUnit = gameState.units.find(u => u.id === (gameState.selectedUnitOnMap ? gameState.selectedUnitOnMap.id : gameState.activeUnitId));
        if (actedUnit) actedUnit.hasActedThisTurn = true;
        
        // Сброс UI
        gameState.selectedUnitOnMap = null; gameState.activeUnitId = null;
        gameState.currentAttackableHexes = []; gameState.blockedAttackableHexes = [];
        gameState.moveMode = false; gameState.weaponMode = null; gameState.abilityMode = null;
        ui.actionPanel.classList.add('hidden');

        // Логика передачи хода: если все юниты походили, раунд завершается
        const livingUnits = gameState.units.filter(u => !u.isDead);
        if (livingUnits.every(u => u.hasActedThisTurn)) {
            startGlobalTurn(); gameState.activePlayer = (gameState.activePlayer === 'host') ? 'guest' : 'host';
        } else {
            const nextPlayer = (gameState.activePlayer === 'host') ? 'guest' : 'host';
            if (livingUnits.some(u => u.owner === nextPlayer && !u.hasActedThisTurn)) gameState.activePlayer = nextPlayer;
        }

        updateHud(); renderUnitsPanel();
        // Принудительно синхронизируем состояние всех юнитов по сети
        network.send('SYNC_COMBAT_STATE', { units: gameState.units, activePlayer: gameState.activePlayer, turnCount: gameState.turnCount });
    }
}

// Отправка апдейта конкретного юнита (для плавности, без полной перезаписи)
function syncUnit(u) { network.send('UNIT_UPDATE', u); }

// Главный обработчик клика по карте в боевой фазе (Стрельба, Использование способностей, Движение)
function handleCombatClick(hex) {
    const tu = gameState.units.find(u => u.q === hex.q && u.r === hex.r && !u.isDead); // Target Unit (цель)

    // 1. Обработка атаки (если включен режим оружия)
    if (gameState.weaponMode !== null && gameState.selectedUnitOnMap) {
        const au = gameState.selectedUnitOnMap; // Attacking Unit
        const wIndex = gameState.weaponMode; const w = au.weapons[wIndex]; 
        const wDef = w.customStats;

        if (tu && tu.owner !== gameState.mySide && gameState.currentAttackableHexes.includes(hex) && !w.used) {
            let dmg = wDef.damage;
            // Укрытие: если цель в астероидах, урон режется на 20%
            const dHex = gameState.map.getHex(tu.q, tu.r);
            if (dHex && dHex.terrain.id === 'asteroid') dmg = Math.floor(dmg * 0.8);
            
            // Расчет урона: сначала щиты, остаток в корпус (HP)
            let shieldDmg = Math.min(tu.currentShield, dmg);
            tu.currentShield -= shieldDmg;
            let hpDmg = dmg - shieldDmg;
            tu.currentHp = Math.max(0, tu.currentHp - hpDmg);
            tu.shakeUntil = Date.now() + 300; // Тряска спрайта при попадании

            // Проверка на уничтожение
            let isUnitDead = false; if(tu.currentHp <= 0) { tu.isDead = true; hex.unitId = null; isUnitDead = true; }
            
            // Запись в лог и синхронизация
            addBattleLog(gameState.turnCount, au, tu, dmg, wDef.name, isUnitDead, false);
            network.send('BATTLE_LOG', { turn: gameState.turnCount, attackerId: au.id, defenderId: tu.id, damage: dmg, weaponName: wDef.name, isDead: isUnitDead, isAbility: false });
            
            w.used = true; gameState.activeUnitId = au.id; 
            gameState.currentAttackableHexes = []; gameState.blockedAttackableHexes = []; gameState.weaponMode = null; 
            syncUnit(au); syncUnit(tu); updateActionPanel(au); renderUnitsPanel(); return;
        }
    } 

    // 2. Обработка применения активной способности
    if (gameState.abilityMode !== null && gameState.selectedUnitOnMap) {
        const au = gameState.selectedUnitOnMap;
        const abId = gameState.abilityMode;
        const abDef = ABILITIES[abId];

        if (tu && tu.owner !== gameState.mySide && gameState.currentAttackableHexes.includes(hex)) {
            let effectType = '';
            if (abId === 'jammer') effectType = 'jammed';
            if (abId === 'stasis') effectType = 'stasis';
            
            // Нельзя стакать одинаковые дебаффы
            if (tu.statusEffects && tu.statusEffects.some(s => s.type === effectType)) { return; }

            // Наложение дебаффа
            if (!tu.statusEffects) tu.statusEffects = [];
            if (abId === 'jammer') tu.statusEffects.push({ type: 'jammed', duration: 2 });
            if (abId === 'stasis') tu.statusEffects.push({ type: 'stasis', duration: 2 });
            
            updateUnitMaxAP(tu); // Сразу пересчитываем AP (т.к. stasis режет скорость)

            au.cooldowns[abId] = abDef.cooldown; au.abilityUsed = true;
            
            addBattleLog(gameState.turnCount, au, tu, 0, abDef.name, false, true);
            network.send('BATTLE_LOG', { turn: gameState.turnCount, attackerId: au.id, defenderId: tu.id, damage: 0, weaponName: abDef.name, isDead: false, isAbility: true });

            gameState.activeUnitId = au.id;
            gameState.currentAttackableHexes = []; gameState.blockedAttackableHexes = []; gameState.abilityMode = null;
            syncUnit(au); syncUnit(tu); updateActionPanel(au); renderUnitsPanel(); return;
        }
    }

    // 3. Обработка перемещения по карте
    if (gameState.moveMode && gameState.selectedUnitOnMap) {
        const u = gameState.selectedUnitOnMap; const dist = hexDistance(u.q, u.r, hex.q, hex.r);
        const targetHex = gameState.map.getHex(hex.q, hex.r); const startHex = gameState.map.getHex(u.q, u.r);
        
        // Нельзя залетать в астероиды
        if (targetHex && targetHex.terrain.id === 'asteroid') { gameState.moveMode = false; updateActionPanel(u); renderUnitsPanel(); return; }

        if (dist > 0 && dist <= u.currentAP && !hex.unitId) { 
            // Проверка, нет ли препятствий на пути (по прямой линии)
            if (checkLineOfSight(startHex, targetHex)) {
                const oh = gameState.map.getHex(u.q, u.r); if (oh) oh.unitId = null;
                u.q = hex.q; u.r = hex.r; hex.unitId = u.id; u.currentAP -= dist; gameState.activeUnitId = u.id; gameState.moveMode = false;
                updateUnitMaxAP(u); syncUnit(u); updateActionPanel(u);
            } else { gameState.moveMode = false; updateActionPanel(u); } // Блок движения
        } else if (gameState.moveMode) { gameState.moveMode = false; updateActionPanel(u); } // Отмена режима движения
        renderUnitsPanel(); return;
    }

    // 4. Выбор своего юнита (если клик не был атакой/движением)
    if (tu && tu.owner === gameState.mySide) {
        if (tu.hasActedThisTurn) return; // Юнит уже завершил действия
        if (gameState.activeUnitId && gameState.activeUnitId !== tu.id) return; // Нельзя переключиться, если другой юнит начал связку действий (например, проехал, но не выстрелил)
        gameState.selectedUnitOnMap = tu; gameState.moveMode = false; gameState.weaponMode = null; gameState.abilityMode = null;
        updateActionPanel(tu); renderUnitsPanel();
    } else {
        // Сброс выделения при клике в пустоту
        gameState.selectedUnitOnMap=null; gameState.currentAttackableHexes=[]; gameState.blockedAttackableHexes=[]; gameState.moveMode=false; gameState.weaponMode=null; gameState.abilityMode=null;
        ui.actionPanel.classList.add('hidden'); renderUnitsPanel();
    }
}

// Привязка всплывающего окна (тултипа) к кнопкам оружия/способностей
function bindTooltip(el, item, isWeapon = false) {
    if (!item) return;
    el.onmouseenter = () => {
        ui.ttIcon.src = item.icon; ui.ttName.innerText = item.name;
        ui.ttType.innerText = isWeapon ? 'Орудийная система' : (item.type === 'active' ? 'Активная система' : 'Пассивная система');
        ui.ttType.className = isWeapon ? 'tt-active' : (item.type === 'active' ? 'tt-active' : 'tt-passive');
        ui.ttDesc.innerText = item.desc;
        
        // Отображение статов, если они есть у сущности
        if (item.cooldown) { ui.ttCdBox.classList.remove('hidden'); ui.ttCd.innerText = item.cooldown; } 
        else { ui.ttCdBox.classList.add('hidden'); }
        
        if (item.range) { ui.ttRangeBox.classList.remove('hidden'); ui.ttRange.innerText = item.range; } 
        else { ui.ttRangeBox.classList.add('hidden'); }
        
        if (item.damage) { ui.ttDamageBox.classList.remove('hidden'); ui.ttDamage.innerText = item.damage; } 
        else { ui.ttDamageBox.classList.add('hidden'); }

        ui.ttChargesBox.classList.add('hidden'); ui.tooltip.classList.remove('hidden');
    };
    el.onmouseleave = () => { ui.tooltip.classList.add('hidden'); };
}

// Отрисовка панели действий выбранного юнита (кнопки "движение", оружия, скиллы)
function updateActionPanel(u) { 
    if (!u) { ui.actionPanel.classList.add('hidden'); return; }
    ui.actionPanel.classList.remove('hidden'); 
    const isStunned = u.statusEffects && u.statusEffects.some(s => s.type === 'stun'); // Проверка на оглушение
    
    // Кнопка передвижения
    let html = `<button id="btn-act-move" title="Движение" class="${gameState.moveMode?'active-action':''}" ${u.currentAP < 1 || isStunned ? 'disabled' : ''}><img src="assets/move.png"></button>`;

    // Кнопки орудий
    u.weapons.forEach((w, index) => {
        let activeClass = (gameState.weaponMode === index) ? 'active-action' : '';
        let disabledStr = (w.used || isStunned) ? 'disabled' : '';
        html += `<button id="btn-wpn-${index}" class="${activeClass}" ${disabledStr}><img src="${w.customStats.icon}"></button>`;
    });

    html += `<div style="width:2px; background:#555; margin:0 5px; border-radius:2px;"></div>`;

    // Кнопки активных способностей
    const abilities = UNIT_STATS[u.type].abilities || [];
    abilities.forEach(ab => {
        const a = ABILITIES[ab];
        if(a && a.type === 'active') {
            let activeClass = (gameState.abilityMode === ab) ? 'active-action' : '';
            // Отключить, если на кулдауне, уже использована в этот ход или юнит в стане
            let disabledStr = (u.cooldowns && u.cooldowns[ab] > 0 || u.abilityUsed || isStunned) ? 'disabled' : '';
            html += `<button id="btn-act-${ab}" class="${activeClass}" ${disabledStr}><img src="${a.icon}"></button>`;
        }
    });

    // Иконки пассивных способностей (некликабельны, только для информации)
    abilities.forEach(ab => {
        const a = ABILITIES[ab];
        if(a && a.type === 'passive') { html += `<div id="passive-ico-${ab}" class="passive-icon"><img src="${a.icon}"></div>`; }
    });

    ui.actionPanel.innerHTML = html;

    // Привязка обработчиков событий к сгенерированным кнопкам
    document.getElementById('btn-act-move').onclick = () => { gameState.moveMode = true; gameState.weaponMode = null; gameState.abilityMode = null; updateActionPanel(u); };
    
    u.weapons.forEach((w, index) => {
        const btn = document.getElementById(`btn-wpn-${index}`);
        if (btn) {
            btn.onclick = () => { gameState.weaponMode = index; gameState.moveMode = false; gameState.abilityMode = null; updateWeaponCone(u, index); updateActionPanel(u); };
            bindTooltip(btn, w.customStats, true);
        }
    });

    abilities.forEach(ab => {
        const a = ABILITIES[ab];
        if (a && a.type === 'active') { 
            const btn = document.getElementById(`btn-act-${ab}`); 
            if (btn) {
                btn.onclick = () => { gameState.abilityMode = ab; gameState.weaponMode = null; gameState.moveMode = false; updateAbilityCone(u, ab); updateActionPanel(u); };
                bindTooltip(btn, a);
            }
        }
        if (a && a.type === 'passive') { const icon = document.getElementById(`passive-ico-${ab}`); if (icon) bindTooltip(icon, a); }
    });
}

// Обновление верхнего HUD-интерфейса (фаза, счетчик ходов, статус хода)
function updateHud() {
    ui.lblPhase.innerText = gameState.phase === 'SETUP' ? 'РАССТАНОВКА' : 'БОЙ';
    const turnPanel = document.getElementById('turn-status-panel');
    if (gameState.phase === 'SETUP') { ui.btnEndTurn.innerText = gameState.ready.me ? "ОЖИДАНИЕ" : "ГОТОВ"; ui.btnEndTurn.disabled = gameState.ready.me; if (turnPanel) turnPanel.classList.add('hidden'); }
    else { 
        const isMyTurn = gameState.activePlayer === gameState.mySide; 
        if (turnPanel) { turnPanel.classList.remove('hidden'); turnPanel.innerText = isMyTurn ? "ВАШ ХОД" : "ХОД ВРАГА"; turnPanel.className = isMyTurn ? 'my-turn' : 'enemy-turn'; }
        ui.btnEndTurn.innerText = "ЗАВЕРШИТЬ"; ui.btnEndTurn.disabled = !isMyTurn; 
    }
    ui.lblTurnCount.innerText = gameState.turnCount;
}

// Отрисовка списка кораблей (справа на экране) в фазах SETUP и COMBAT
function renderUnitsPanel() {
    ui.unitsList.innerHTML = '';
    const list = gameState.phase === 'SETUP' ? gameState.unitsToPlace : gameState.units.filter(u => u.owner === gameState.mySide);
    
    list.forEach(i => {
        const s = UNIT_STATS[i.type]; 
        const isSel = (gameState.phase === 'SETUP' && gameState.selectedCardId === i.id) || (gameState.phase === 'COMBAT' && gameState.selectedUnitOnMap && gameState.selectedUnitOnMap.id === i.id);
        const card = document.createElement('div'); 
        const actedClass = i.hasActedThisTurn ? ' acted' : '';
        const notMyTurnClass = (gameState.phase === 'COMBAT' && gameState.activePlayer !== gameState.mySide) ? ' not-my-turn' : '';
        
        // CSS классы для выделения состояния (убит, завершил ход, выбран)
        card.className = `unit-card ${isSel ? 'selected' : ''} ${i.isDead ? 'dead' : ''}${actedClass}${notMyTurnClass}`; 
        card.dataset.id = i.id; 
        
        const maxHp = i.maxHp || s.maxHp;
        const maxShield = i.maxShield !== undefined ? i.maxShield : s.maxShield;
        const shieldRegen = i.shieldRegen !== undefined ? i.shieldRegen : s.shieldRegen;
        const baseSpeed = i.baseSpeed !== undefined ? i.baseSpeed : s.speed;
        
        const currentHp = i.currentHp !== undefined ? i.currentHp : maxHp;
        const currentShield = i.currentShield !== undefined ? i.currentShield : maxShield;

        // Расчет процентов заполнения полосок HP и Щитов
        const hpP = i.isDead ? 0 : (currentHp / maxHp * 100); 
        const shieldP = (i.isDead || maxShield===0) ? 0 : (currentShield / maxShield * 100); 

        const maxAP = i.maxAP !== undefined ? i.maxAP : baseSpeed;
        const currentAP = i.currentAP !== undefined ? i.currentAP : baseSpeed;
        
        let apBlocksHtml = '<div class="card-ap-container">';
        for (let b = 0; b < maxAP; b++) { apBlocksHtml += `<div class="ap-block ${i.isDead || b >= currentAP ? 'spent' : ''}"></div>`; }
        apBlocksHtml += '</div>';

        // Генерация иконок активных эффектов/дебаффов
        let statusesHtml = '';
        if (i.statusEffects && i.statusEffects.length > 0) {
            const sorted = [...i.statusEffects].sort((a, b) => a.duration - b.duration); // Сортировка по времени действия
            statusesHtml += '<div class="card-status-container">';
            sorted.forEach(se => {
                const seDef = STATUS_EFFECTS_DICT[se.type];
                if (seDef) { statusesHtml += `<img src="${seDef.icon}" class="status-icon" data-type="${se.type}" data-duration="${se.duration}">`; }
            });
            statusesHtml += '</div>';
        }
        
        card.innerHTML = `
            <div class="card-bars-container">
                <div class="card-shield-bar">
                    <div class="card-shield-fill" style="width:${shieldP}%;"></div>
                    <div class="card-shield-text"><span>${i.isDead ? "" : currentShield}</span><span class="regen-text">+${shieldRegen}</span></div>
                </div>
                <div class="card-hp-bar">
                    <div class="card-hp-fill" style="width:${hpP}%;"></div>
                    <div class="card-hp-text">${i.isDead ? "МЕРТВ" : currentHp}</div>
                </div>
            </div>
            ${statusesHtml}
            <div class="card-image-container" style="background-image: url('${s.img}');">
                ${!i.id.includes(gameState.mySide) ? `<div class="card-name-block">${s.name}</div>` : ''} 
                ${apBlocksHtml}
            </div>`;

        // Кнопка расстановки корабля в фазе SETUP
        if (gameState.phase === 'SETUP' && !i.hasPlaced) { 
            const b = document.createElement('button'); b.className = 'btn-place'; b.innerText = 'В БОЙ'; 
            b.onclick = (e) => { e.stopPropagation(); gameState.selectedCardId = i.id; renderUnitsPanel(); }; 
            card.querySelector('.card-image-container').appendChild(b);
        } else if (gameState.phase === 'COMBAT' && !i.isDead) { 
            card.onclick = () => { 
                if (i.hasActedThisTurn || (gameState.activeUnitId && gameState.activeUnitId !== i.id)) return; 
                gameState.selectedUnitOnMap = i; gameState.moveMode = false; gameState.weaponMode = null; gameState.abilityMode = null; updateActionPanel(i); renderUnitsPanel(); 
            }; 
        }
        card.onmouseenter = () => { gameState.hoveredUnitId = i.id; }; card.onmouseleave = () => { gameState.hoveredUnitId = null; };
        ui.unitsList.appendChild(card);

        // Тултипы для дебаффов
        card.querySelectorAll('.status-icon').forEach(icon => {
            icon.onclick = (e) => e.stopPropagation();
            icon.onmouseenter = () => {
                const type = icon.dataset.type; const duration = icon.dataset.duration; const seDef = STATUS_EFFECTS_DICT[type];
                ui.stDesc.innerText = seDef.desc; ui.stDuration.innerText = duration; ui.statusTooltip.classList.remove('hidden');
            };
            icon.onmouseleave = () => { ui.statusTooltip.classList.add('hidden'); };
        });
    });
}

// Синхронизация подсветки: если наводим мышь на карту, подсвечивается карточка справа, и наоборот
function syncCardHoverEffects() { Array.from(ui.unitsList.children).forEach(c=>{ if(c.dataset.id===gameState.hoveredUnitId)c.classList.add('hovered'); else c.classList.remove('hovered'); }); }

// Добавление текстовой записи в журнал боя
function addBattleLog(turn, attacker, defender, damage, weaponName, isDead = false, isAbility = false) {
    const log = document.getElementById('battle-log'); if (!log) return;
    const aClass = attacker.owner === 'host' ? 'log-host' : 'log-guest'; // Окрашивание имен в зависимости от владельца
    const dClass = defender.owner === 'host' ? 'log-host' : 'log-guest';
    
    const entry = document.createElement('div'); entry.className = 'log-entry';
    let text = '';
    
    if (isAbility) {
        text = `<span class="log-turn">[${turn}]</span> <span class="${aClass}">${UNIT_STATS[attacker.type].name}</span> применяет [${weaponName}] на <span class="${dClass}">${UNIT_STATS[defender.type].name}</span>.`;
    } else {
        text = `<span class="log-turn">[${turn}]</span> <span class="${aClass}">${UNIT_STATS[attacker.type].name}</span> наносит <b>${damage}</b> урона из [${weaponName}] по <span class="${dClass}">${UNIT_STATS[defender.type].name}</span>.`;
        if (isDead) text += ` <br><span style="color:#ff4444; font-weight:bold;">Корабль уничтожен!</span>`;
    }
    
    entry.innerHTML = text; log.appendChild(entry); log.scrollTop = log.scrollHeight; // Автопрокрутка вниз
}

// ==========================================
// CANVAS ОПЕРАЦИИ (Рендер графики и управление мышью)
// ==========================================

// Обработка клика мыши по холсту (Canvas)
ui.canvas.addEventListener('mousedown', (e) => {
    // Блокируем ЛКМ, если не наш ход
    if (gameState.phase === 'COMBAT' && gameState.activePlayer !== gameState.mySide && e.button === 0) return;
    
    // Пересчет координат мыши в пикселях (с учетом позиции камеры) в координаты гекса (q, r)
    const rect=ui.canvas.getBoundingClientRect(); const mx=e.clientX-rect.left-gameState.camera.x; const my=e.clientY-rect.top-gameState.camera.y;
    const hex=gameState.map.getHex(gameState.map.pixelToHex(mx,my).q, gameState.map.pixelToHex(mx,my).r);
    
    // ЛКМ (0) — действие (поставить корабль, походить, атаковать)
    if (e.button===0 && hex) { if(gameState.phase==='SETUP' && gameState.selectedCardId) handleSetupPlacement(hex); else if(gameState.phase==='COMBAT') handleCombatClick(hex); }
    // ПКМ (2) — начало перемещения (pan) камеры
    if (e.button===2) { gameState.camera.isDragging=true; gameState.camera.startX=e.clientX-gameState.camera.x; gameState.camera.startY=e.clientY-gameState.camera.y; }
});

// Движение мыши над холстом (перетаскивание камеры и обновление ховера)
window.addEventListener('mousemove', (e) => {
    if (gameState.camera.isDragging) { gameState.camera.x=e.clientX-gameState.camera.startX; gameState.camera.y=e.clientY-gameState.camera.startY; }
    const rect=ui.canvas.getBoundingClientRect(); const mx=e.clientX-rect.left-gameState.camera.x; const my=e.clientY-rect.top-gameState.camera.y;
    gameState.hoveredHex=gameState.map.getHex(gameState.map.pixelToHex(mx,my).q, gameState.map.pixelToHex(mx,my).r);
    gameState.hoveredUnitId = (gameState.hoveredHex && gameState.hoveredHex.unitId) ? gameState.hoveredHex.unitId : null;
    syncCardHoverEffects();
    
    // Логика следования всплывающих подсказок за курсором мыши, чтобы не вылезать за края экрана
    [ui.tooltip, ui.statusTooltip].forEach(tt => {
        if (!tt.classList.contains('hidden')) {
            let tx = e.clientX + 15; let ty = e.clientY + 15;
            if (tx + tt.offsetWidth > window.innerWidth) tx = e.clientX - tt.offsetWidth - 10;
            if (ty + tt.offsetHeight > window.innerHeight) ty = e.clientY - tt.offsetHeight - 10;
            tt.style.left = `${tx}px`; tt.style.top = `${ty}px`;
        }
    });
});
window.addEventListener('mouseup', () => gameState.camera.isDragging=false); // Завершение перетаскивания камеры
window.addEventListener('contextmenu', e=>e.preventDefault()); // Отключение стандартного контекстного меню браузера на ПКМ

// Отрисовка зоны доступного перемещения юнита (синяя заливка гексов)
function drawUnitOverlay(u) {
    if (!gameState.moveMode) return; 
    const m = gameState.map; const startHex = m.getHex(u.q, u.r);
    m.getAllHexes().forEach(h => { 
        const d = hexDistance(u.q, u.r, h.q, h.r); 
        // Проверка: радиус AP, не астероид, пустой гекс, есть линия видимости
        if (d > 0 && d <= u.currentAP && h.terrain.id !== 'asteroid' && !h.unitId && checkLineOfSight(startHex, h)) { 
            const pp = m.hexToPixel(h.q, h.r); const px = pp.x + gameState.camera.x; const py = pp.y + gameState.camera.y; 
            ctx.beginPath(); 
            // Отрисовка 6 граней гексагона
            for(let j=0;j<6;j++) { ctx.lineTo(px + (m.hexSize/2) * Math.cos(j*Math.PI/3), py + (m.hexSize/2) * Math.sin(j*Math.PI/3)); }
            ctx.fillStyle = 'rgba(0, 128, 255, 0.6)'; ctx.fill(); 
        } 
    });
}

// ГЛАВНЫЙ ИГРОВОЙ ЦИКЛ ОТРИСОВКИ (Game Loop)
// Вызывается каждый кадр (обычно 60 раз в секунду через requestAnimationFrame)
function gameLoop() {
    ctx.clearRect(0,0,ui.canvas.width,ui.canvas.height); if(!gameState.map)return; // Очистка экрана
    
    // 1. Отрисовка карты (Гексы и Ландшафт)
    gameState.map.getAllHexes().forEach(h=>{
        const p=gameState.map.hexToPixel(h.q,h.r); const px=p.x+gameState.camera.x; const py=p.y+gameState.camera.y;
        
        ctx.beginPath(); for(let i=0;i<6;i++) { ctx.lineTo(px+gameState.map.hexSize*Math.cos(i*Math.PI/3), py+gameState.map.hexSize*Math.sin(i*Math.PI/3)); } ctx.closePath();
        ctx.fillStyle=(gameState.hoveredHex===h)?'#555':h.terrain.color; ctx.fill(); // Если курсор над гексом - подсвечиваем серым, иначе - цвет ландшафта
        
        // Отрисовка зон расстановки (SETUP phase) красным и синим
        if(gameState.phase==='SETUP'){ if(gameState.mySide==='host'&&h.col<4){ctx.strokeStyle='#2196F3';ctx.lineWidth=3;} else if(gameState.mySide==='guest'&&h.col>=9){ctx.strokeStyle='#F44336';ctx.lineWidth=3;} else{ctx.strokeStyle='#222';ctx.lineWidth=1;} } else {ctx.strokeStyle='#222';ctx.lineWidth=1;} 
        ctx.stroke();
        
        // Отрисовка радиуса атаки/способности (мелкие красные/зеленые гексы внутри больших)
        if(gameState.weaponMode !== null || gameState.abilityMode !== null || gameState.attackHovered) {
            const smallSize = gameState.map.hexSize / 2;
            const highlightColor = (gameState.abilityMode !== null) ? 'rgba(76, 175, 80, 0.8)' : '#cc2714'; // Зеленый для способностей, красный для оружия
            const blockedColor = (gameState.abilityMode !== null) ? 'rgba(38, 88, 40, 0.8)' : '#6b0000'; // Темные оттенки для заблокированных

            if (gameState.currentAttackableHexes.includes(h)) {
                ctx.beginPath(); for(let i=0;i<6;i++){ ctx.lineTo(px+smallSize*Math.cos(i*Math.PI/3), py+smallSize*Math.sin(i*Math.PI/3)); } ctx.closePath();
                ctx.fillStyle = highlightColor; ctx.fill();
            } else if (gameState.blockedAttackableHexes && gameState.blockedAttackableHexes.includes(h)) {
                ctx.beginPath(); for(let i=0;i<6;i++){ ctx.lineTo(px+smallSize*Math.cos(i*Math.PI/3), py+smallSize*Math.sin(i*Math.PI/3)); } ctx.closePath();
                ctx.fillStyle = blockedColor; ctx.fill();
            }
        }
    });
    
    // 2. Отрисовка радиуса перемещения выбранного юнита
    if(gameState.selectedUnitOnMap) drawUnitOverlay(gameState.selectedUnitOnMap);
    
    // 3. Отрисовка кораблей
    gameState.units.forEach(u=>{
        if(u.isDead) return; // Убитые не рендерятся
        const p = gameState.map.hexToPixel(u.q, u.r); 
        
        // Механика "тряски" при получении урона
        let dx = 0, dy = 0; if (u.shakeUntil && Date.now() < u.shakeUntil) { dx = (Math.random() - 0.5) * 8; dy = (Math.random() - 0.5) * 8; }
        const x = p.x + gameState.camera.x + dx; const y = p.y + gameState.camera.y + dy;

        // Радиальный градиент (Свечение под кораблем: синее для хоста, красное для гостя)
        const glowColor = u.owner === 'host' ? 'rgba(33, 150, 243, 0.8)' : 'rgba(244, 67, 54, 0.8)';
        const grad = ctx.createRadialGradient(x, y, 5, x, y, 28);
        grad.addColorStop(0, glowColor); grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(x, y, 28, 0, Math.PI*2); ctx.fill();

        // Отрисовка предзагруженной иконки корабля
        const iconImg = MAP_ICONS[UNIT_STATS[u.type].icon];
        if (iconImg && iconImg.complete) { ctx.drawImage(iconImg, x - 18, y - 18, 36, 36); }

        // Обводка вокруг корабля при наведении (желтая) или выборе (голубая)
        ctx.beginPath(); ctx.arc(x, y, 20, 0, Math.PI*2);
        if(gameState.hoveredUnitId===u.id){ctx.strokeStyle='#ffeb3b';ctx.lineWidth=3; ctx.stroke();} 
        else if(gameState.selectedUnitOnMap===u){ctx.strokeStyle='#0ff';ctx.lineWidth=3; ctx.stroke();}
    });
    
    // Запрос следующего кадра
    requestAnimationFrame(gameLoop);
}
